//! Import connections from an OpenSSH client config (`~/.ssh/config`).
//!
//! Two commands with one plan between them. `import_ssh_config_preview`
//! reads the file and reports what would be created and what is skipped,
//! writing nothing. `import_ssh_config_apply` reads the file again, builds
//! the same plan under the data lock and stores the items the user picked.
//! The items travel as hashes of their contents, so the frontend cannot ask
//! for anything the backend did not plan, and a config edited after the
//! preview is refused instead of importing what the user never saw.
//!
//! The rules for mapping a host (see also `docs/ssh-config-import.md`):
//!
//! - Each literal name on a `Host` line is one connection, named after it.
//!   Two aliases that end up at the same place give one connection.
//! - No `User`: the login name, which is what `ssh` itself uses.
//! - No `IdentityFile`: an agent credential, the nearest thing to what `ssh`
//!   tries first. Several `IdentityFile`s: the first, because a credential
//!   holds one key. Either way the preview says so.
//! - A key is stored as a path. Its file is never opened here.
//! - A host that cannot be imported faithfully is skipped with its reason;
//!   importing it without its port, proxy or jump host would connect to
//!   something the config does not describe.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::commands::blocking;
use crate::commands::connections::{
    check_connection, insert_new_connection, ConnectionAdvanced, ConnectionFields,
};
use crate::commands::credentials::validate_credential_fields;
use crate::models::{AppData, Connection, ConnectionKind, Credential, CredentialKind};
use crate::ssh_config::{
    display_path, is_unix_socket, jump_value, parse_forward_end, parse_jump_hop, parse_port,
    valid_host, HostEntry, ParsedConfig, Proxy, ResolvedHost, Source, Value,
};
use crate::storage::{load_data, with_data_mut};

#[cfg(test)]
use ts_rs::TS;

const DEFAULT_CONFIG_PATH: &str = "~/.ssh/config";
const DEFAULT_SSH_PORT: u16 = 22;
/// Hosts one import plans, so a generated or hostile file stays quick to
/// preview. Each host walks the whole file once.
const MAX_HOSTS: usize = 2000;
/// `check_connection`'s limit, tested first so an absurdly long name is not
/// matched against every pattern in the file.
const MAX_NAME_CHARS: usize = 128;
const STALE_PREVIEW: &str =
    "The config or your connections changed since this preview. Review it again before importing.";

/// Why an entry of the config is not offered for import.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "snake_case")]
pub enum ImportSkipCategory {
    /// A wildcard or negated `Host` pattern, which only supplies options.
    Pattern,
    /// SSIX already has this destination.
    AlreadyImported,
    /// SSIX has a different connection under this name. It is never changed.
    NameClash,
    /// An earlier entry of this config has the same name or destination.
    Duplicate,
    /// Valid for `ssh`, but SSIX has no way to do it.
    Unsupported,
    /// The config's value could not be used.
    Invalid,
}

/// A credential one planned connection will use.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ImportCredentialPlan {
    /// What it signs in to, in the words the connection form uses.
    pub role: String,
    pub name: String,
    pub username: String,
    /// The key's path; `null` means keys from the SSH agent.
    pub private_key_path: Option<String>,
    /// Whether the credential exists already and will be shared.
    pub exists: bool,
}

/// A connection the import can create.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ImportItem {
    /// Hash of what this item would create; `import_ssh_config_apply` takes it.
    pub key: String,
    pub name: String,
    /// The connection kind (`direct`, `jump_shell`, `port_forward`, ...).
    #[serde(rename = "type")]
    #[cfg_attr(test, ts(rename = "type"))]
    pub kind: String,
    /// Where it goes, in one line.
    pub target: String,
    pub credentials: Vec<ImportCredentialPlan>,
    /// Shown in full: importing it means this command runs on connect.
    pub proxy_command: Option<String>,
    /// Defaults the import chose and details it had to drop.
    pub notes: Vec<String>,
    pub source: String,
}

/// An entry of the config that will not become a connection.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ImportSkip {
    pub name: String,
    pub category: ImportSkipCategory,
    pub reason: String,
    pub source: String,
}

/// A line or file the reader passed over.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ImportNotice {
    pub message: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ImportPreview {
    pub path: String,
    /// Every file read, the config first.
    pub files: Vec<String>,
    pub items: Vec<ImportItem>,
    pub skipped: Vec<ImportSkip>,
    pub notices: Vec<ImportNotice>,
}

/// What an import stored, by name.
#[derive(Debug, Clone, Default, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct ImportResult {
    pub connections: Vec<String>,
    pub credentials: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ImportApplyInput {
    /// The file the preview read; absent means `~/.ssh/config`.
    #[serde(default)]
    pub path: Option<String>,
    /// `ImportItem::key` of every item to create.
    pub keys: Vec<String>,
}

/// What the mapping needs from the machine it runs on.
struct ImportEnv {
    home: PathBuf,
    /// What `ssh` uses when the config sets no `User`.
    local_user: Option<String>,
}

impl ImportEnv {
    fn current() -> Result<Self, String> {
        let home =
            dirs::home_dir().ok_or_else(|| "Could not resolve your home directory".to_string())?;
        let local_user = ["USER", "USERNAME"]
            .iter()
            .filter_map(|name| std::env::var(name).ok())
            .map(|value| value.trim().to_string())
            .find(|value| !value.is_empty());
        Ok(Self { home, local_user })
    }
}

/// The file to read: `~/.ssh/config` unless the user named another one.
fn config_path(path: Option<&str>, home: &Path) -> Result<PathBuf, String> {
    let path = path
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or(DEFAULT_CONFIG_PATH);
    if let Some(rest) = path.strip_prefix("~/") {
        return Ok(home.join(rest));
    }
    if Path::new(path).is_absolute() {
        return Ok(PathBuf::from(path));
    }
    Err("Enter an absolute path, or one that starts with ~/".to_string())
}

/// A reason a host or forward is left out.
struct Refusal {
    category: ImportSkipCategory,
    reason: String,
}

impl Refusal {
    fn invalid(reason: impl Into<String>) -> Self {
        Self {
            category: ImportSkipCategory::Invalid,
            reason: reason.into(),
        }
    }

    fn unsupported(reason: impl Into<String>) -> Self {
        Self {
            category: ImportSkipCategory::Unsupported,
            reason: reason.into(),
        }
    }

    fn skip(self, name: &str, source: &Source) -> ImportSkip {
        ImportSkip {
            name: name.to_string(),
            category: self.category,
            reason: self.reason,
            source: source.to_string(),
        }
    }
}

/// The credential a host needs, before it is known whether one exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct CredentialSpec {
    username: String,
    /// `None` means keys from the SSH agent.
    key_path: Option<String>,
}

impl CredentialSpec {
    fn default_name(&self) -> String {
        let name = match &self.key_path {
            Some(path) => {
                let file = Path::new(path)
                    .file_name()
                    .map(|f| f.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone());
                format!("{}@{}", self.username, file)
            }
            None => format!("{} (agent)", self.username),
        };
        // Room for the " (2)" `free_credential_name` may add.
        name.chars().take(MAX_NAME_CHARS - 8).collect()
    }

    fn kind(&self) -> CredentialKind {
        match &self.key_path {
            Some(path) => CredentialKind::SshKey {
                private_key_path: Some(path.clone()),
                private_key: None,
                passphrase: None,
            },
            None => CredentialKind::Agent {},
        }
    }

    /// A named credential that already says the same thing. Private ones
    /// belong to their connection and are never shared.
    fn find_in<'a>(&self, credentials: &'a [Credential]) -> Option<&'a Credential> {
        credentials.iter().find(|c| {
            !c.is_private
                && c.username == self.username
                && match (&c.kind, &self.key_path) {
                    (
                        CredentialKind::SshKey {
                            private_key_path: Some(have),
                            ..
                        },
                        Some(want),
                    ) => have == want,
                    (CredentialKind::Agent {}, None) => true,
                    _ => false,
                }
        })
    }
}

/// The name `spec` goes by in `credentials`, once it is created if need be.
fn planned_credential_name(credentials: &[Credential], spec: &CredentialSpec) -> String {
    match spec.find_in(credentials) {
        Some(existing) => existing.name.clone(),
        None => free_credential_name(credentials, &spec.default_name()),
    }
}

fn free_credential_name(credentials: &[Credential], base: &str) -> String {
    let taken = |name: &str| credentials.iter().any(|c| c.name == name);
    if !taken(base) {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base} ({n})"))
        .find(|name| !taken(name))
        .unwrap_or_else(|| base.to_string())
}

/// Find the credential `spec` describes, or store it as `name`. Only a path
/// and a username go in: there is nothing for the secrets file.
fn ensure_credential(
    data: &mut AppData,
    spec: &CredentialSpec,
    name: &str,
) -> Result<String, String> {
    if let Some(existing) = spec.find_in(&data.credentials) {
        return Ok(existing.id.clone());
    }
    validate_credential_fields(name, &spec.username, false)?;
    let id = Uuid::new_v4().to_string();
    data.credentials.push(Credential {
        id: id.clone(),
        name: name.to_string(),
        username: spec.username.clone(),
        kind: spec.kind(),
        is_private: false,
    });
    Ok(id)
}

/// One SSH server as the config describes it: a host, or a jump host.
#[derive(Debug, Clone)]
struct ServerPlan {
    host: String,
    port: u16,
    credential: CredentialSpec,
    notes: Vec<String>,
}

impl ServerPlan {
    fn address(&self) -> String {
        format!("{}@{}:{}", self.credential.username, self.host, self.port)
    }
}

/// `%h` and `%%` are the only tokens OpenSSH expands in `HostName`.
fn expand_host_name(raw: &str, alias: &str) -> Result<String, String> {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('h') => out.push_str(alias),
            Some('%') => out.push('%'),
            _ => return Err(format!("HostName '{raw}' uses a token SSIX cannot expand")),
        }
    }
    Ok(out)
}

/// What an `IdentityFile` path may refer to.
struct IdentityTokens<'a> {
    env: &'a ImportEnv,
    alias: &'a str,
    host: &'a str,
    port: u16,
    user: &'a str,
}

/// Turn an `IdentityFile` value into the absolute path a credential stores,
/// which is opened as written when connecting. Nothing reads the file here.
fn identity_path(raw: &str, tokens: &IdentityTokens) -> Result<String, String> {
    let mut expanded = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            expanded.push(c);
            continue;
        }
        match chars.next() {
            Some('%') => expanded.push('%'),
            Some('d') => expanded.push_str(&tokens.env.home.to_string_lossy()),
            Some('h') => expanded.push_str(tokens.host),
            Some('n') => expanded.push_str(tokens.alias),
            Some('p') => expanded.push_str(&tokens.port.to_string()),
            Some('r') => expanded.push_str(tokens.user),
            Some('u') if tokens.env.local_user.is_some() => {
                expanded.push_str(tokens.env.local_user.as_deref().unwrap_or_default())
            }
            Some(other) => {
                return Err(format!(
                    "IdentityFile '{raw}' uses the token %{other}, which SSIX cannot expand"
                ))
            }
            None => return Err(format!("IdentityFile '{raw}' ends with a lone %")),
        }
    }
    let path = if expanded == "~" {
        tokens.env.home.clone()
    } else if let Some(rest) = expanded.strip_prefix("~/") {
        tokens.env.home.join(rest)
    } else if expanded.starts_with('~') {
        return Err(format!(
            "IdentityFile '{raw}' uses a ~user path, which SSIX cannot expand"
        ));
    } else {
        PathBuf::from(&expanded)
    };
    if !path.is_absolute() {
        return Err(format!(
            "IdentityFile '{raw}' is a relative path, so it depends on where ssh runs"
        ));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Work out one server from its resolved options. `user` and `port` are the
/// explicit parts of a `ProxyJump` hop, which win over the hop's own config.
fn server_plan(
    env: &ImportEnv,
    alias: &str,
    resolved: &ResolvedHost,
    user: Option<&str>,
    port: Option<u16>,
) -> Result<ServerPlan, Refusal> {
    let mut notes = Vec::new();

    let host = match &resolved.host_name {
        Some(value) => {
            let raw = value.single().map_err(Refusal::invalid)?;
            expand_host_name(raw, alias)
                .map_err(|why| Refusal::unsupported(format!("{why} (on {})", value.at)))?
        }
        None => alias.to_string(),
    };
    if !valid_host(&host) {
        return Err(Refusal::invalid(format!("'{host}' cannot be a host name")));
    }

    let port = match (port, &resolved.port) {
        (Some(port), _) => port,
        (None, Some(value)) => {
            let raw = value.single().map_err(Refusal::invalid)?;
            parse_port(raw)
                .map_err(|why| Refusal::invalid(format!("Port on {}: {why}", value.at)))?
        }
        (None, None) => DEFAULT_SSH_PORT,
    };

    let username = match (user, &resolved.user) {
        (Some(user), _) => user.to_string(),
        (None, Some(value)) => {
            let raw = value.single().map_err(Refusal::invalid)?;
            if raw.contains('%') {
                return Err(Refusal::unsupported(format!(
                    "User on {} uses a token, which SSIX cannot expand",
                    value.at
                )));
            }
            raw.to_string()
        }
        (None, None) => match &env.local_user {
            Some(local) => {
                notes.push(format!(
                    "The config sets no User: signs in as {local}, your login name, as ssh does"
                ));
                local.clone()
            }
            None => {
                return Err(Refusal::unsupported(
                    "The config sets no User and your login name could not be determined",
                ))
            }
        },
    };

    let identities: Vec<&Value> = resolved
        .identity_files
        .iter()
        .filter(|value| !matches!(value.single(), Ok(word) if word.eq_ignore_ascii_case("none")))
        .collect();
    let key_path = match identities.first() {
        Some(value) => {
            let raw = value.single().map_err(Refusal::invalid)?;
            let tokens = IdentityTokens {
                env,
                alias,
                host: &host,
                port,
                user: &username,
            };
            Some(identity_path(raw, &tokens).map_err(Refusal::unsupported)?)
        }
        None => {
            notes.push("The config sets no IdentityFile: signs in with the SSH agent".to_string());
            None
        }
    };
    if identities.len() > 1 {
        notes.push(format!(
            "The config lists {} identity files: SSIX uses the first",
            identities.len()
        ));
    }

    Ok(ServerPlan {
        host,
        port,
        credential: CredentialSpec { username, key_path },
        notes,
    })
}

/// How a host is reached.
enum Route {
    Direct,
    Command(String),
    Jump(ServerPlan),
}

fn proxy_is_none(proxy: &Proxy) -> bool {
    match proxy {
        Proxy::Jump(value) => jump_value(&value.raw).eq_ignore_ascii_case("none"),
        Proxy::Command(value) => value.raw.trim().eq_ignore_ascii_case("none"),
    }
}

fn route(
    env: &ImportEnv,
    config: &ParsedConfig,
    alias: &str,
    resolved: &ResolvedHost,
) -> Result<Route, Refusal> {
    let Some(proxy) = &resolved.proxy else {
        return Ok(Route::Direct);
    };
    if proxy_is_none(proxy) {
        return Ok(Route::Direct);
    }
    match proxy {
        Proxy::Command(value) => {
            value.args.as_ref().map_err(Refusal::invalid)?;
            let command = value.raw.trim();
            crate::proxy::validate(command)
                .map_err(|why| Refusal::unsupported(format!("{why} (on {})", value.at)))?;
            Ok(Route::Command(command.to_string()))
        }
        Proxy::Jump(value) => {
            value.args.as_ref().map_err(Refusal::invalid)?;
            let text = jump_value(&value.raw);
            let hops = text.split(',').count();
            if hops > 1 {
                return Err(Refusal::unsupported(format!(
                    "ProxyJump on {} has {hops} hops ({text}): SSIX connects through one jump host",
                    value.at
                )));
            }
            let hop = parse_jump_hop(text)
                .map_err(|why| Refusal::invalid(format!("ProxyJump on {}: {why}", value.at)))?;
            if hop.host == alias {
                return Err(Refusal::unsupported(format!(
                    "ProxyJump on {} makes this host jump through itself",
                    value.at
                )));
            }
            let resolved_hop = config.resolve(&hop.host);
            if resolved_hop
                .proxy
                .as_ref()
                .is_some_and(|p| !proxy_is_none(p))
            {
                return Err(Refusal::unsupported(format!(
                    "The jump host {} goes through another hop of its own: SSIX connects through one jump host",
                    hop.host
                )));
            }
            let server = server_plan(env, &hop.host, &resolved_hop, hop.user.as_deref(), hop.port)
                .map_err(|refusal| Refusal {
                    category: refusal.category,
                    reason: format!("Jump host {}: {}", hop.host, refusal.reason),
                })?;
            Ok(Route::Jump(server))
        }
    }
}

/// A connection the config asks for, with its credentials still described
/// rather than resolved.
#[derive(Debug, Clone)]
struct PlannedConnection {
    name: String,
    source: Source,
    host: String,
    port: u16,
    /// `gateway_credential_id` stays blank until the credential exists.
    kind: ConnectionKind,
    target_credential: Option<CredentialSpec>,
    gateway_credential: Option<CredentialSpec>,
    proxy_command: Option<String>,
    summary: String,
    notes: Vec<String>,
}

impl PlannedConnection {
    /// Identifies what this item creates, so `import_ssh_config_apply` can
    /// tell the item it re-planned is the one the user saw. Credential names
    /// stay out: they follow from what else is stored at the time.
    fn key(&self) -> String {
        let contents = json!({
            "name": self.name,
            "host": self.host,
            "port": self.port,
            "kind": self.kind,
            "target": self.target_credential,
            "gateway": self.gateway_credential,
            "proxy": self.proxy_command,
        });
        crate::backup::sha256_hex(contents.to_string().as_bytes())
    }

    fn signature(&self) -> Json {
        signature(
            &self.kind,
            self.host.as_str(),
            self.port,
            self.proxy_command.as_deref(),
            self.target_credential.as_ref().map(|c| c.username.as_str()),
            self.gateway_credential
                .as_ref()
                .map(|c| c.username.as_str()),
        )
    }

    fn fields(&self, target_id: Option<String>, gateway_id: Option<String>) -> ConnectionFields {
        let mut kind = self.kind.clone();
        if let (Some(slot), Some(id)) = (kind.gateway_credential_id_mut(), gateway_id) {
            *slot = id;
        }
        ConnectionFields {
            name: self.name.clone(),
            host: self.host.clone(),
            port: self.port,
            credential_id: target_id,
            kind,
            verbosity: 0,
            extra_args: None,
            proxy_command: self.proxy_command.clone(),
            login_command: None,
            remote_path: None,
            tags: Vec::new(),
            color: None,
            advanced: ConnectionAdvanced::default(),
        }
    }
}

/// Where a connection goes and as whom, whatever it is called and whichever
/// credential it signs in with: a user who renames an imported connection,
/// or gives it a password instead of the key, still has that destination.
fn signature(
    kind: &ConnectionKind,
    host: &str,
    port: u16,
    proxy_command: Option<&str>,
    target_user: Option<&str>,
    gateway_user: Option<&str>,
) -> Json {
    let mut kind_json = serde_json::to_value(kind).unwrap_or(Json::Null);
    if let Some(fields) = kind_json.as_object_mut() {
        fields.remove("gateway_credential_id");
    }
    // Two-hop kinds repeat their far end in `host` and `port`.
    let direct = matches!(kind, ConnectionKind::Direct);
    json!({
        "kind": kind_json,
        "host": direct.then_some(host),
        "port": direct.then_some(port),
        "proxy": proxy_command.map(str::trim).filter(|p| !p.is_empty()),
        "target_user": target_user,
        "gateway_user": gateway_user,
    })
}

fn connection_signature(connection: &Connection, credentials: &[Credential]) -> Json {
    let username = |id: &str| {
        credentials
            .iter()
            .find(|c| c.id == id)
            .map(|c| c.username.as_str())
    };
    let gateway_user = serde_json::to_value(&connection.kind)
        .ok()
        .and_then(|kind| {
            kind.get("gateway_credential_id")
                .and_then(Json::as_str)
                .map(str::to_string)
        })
        .and_then(|id| username(&id));
    // A forward only signs in to its SSH server; its `credential_id` is unused.
    let target_user = if connection.kind.is_forward() {
        None
    } else {
        connection.credential_id.as_deref().and_then(username)
    };
    signature(
        &connection.kind,
        &connection.host,
        connection.port,
        connection.proxy_command.as_deref(),
        target_user,
        gateway_user,
    )
}

fn main_connection(
    alias: &str,
    at: &Source,
    server: &ServerPlan,
    route: &Route,
) -> PlannedConnection {
    let mut planned = PlannedConnection {
        name: alias.to_string(),
        source: at.clone(),
        host: server.host.clone(),
        port: server.port,
        kind: ConnectionKind::Direct,
        target_credential: Some(server.credential.clone()),
        gateway_credential: None,
        proxy_command: None,
        summary: server.address(),
        notes: server.notes.clone(),
    };
    match route {
        Route::Direct => {}
        Route::Command(command) => planned.proxy_command = Some(command.clone()),
        Route::Jump(jump) => {
            planned.kind = ConnectionKind::JumpShell {
                gateway_host: jump.host.clone(),
                gateway_port: jump.port,
                gateway_credential_id: String::new(),
                destination_host: server.host.clone(),
                destination_port: server.port,
            };
            planned.gateway_credential = Some(jump.credential.clone());
            planned.summary = format!("{} through {}", server.address(), jump.address());
            planned
                .notes
                .extend(jump.notes.iter().map(|note| format!("Jump host: {note}")));
        }
    }
    planned
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ForwardFlavor {
    Local,
    Remote,
    Dynamic,
}

fn forward_refusal(args: &[String], why: String) -> Refusal {
    if args.iter().any(|arg| is_unix_socket(arg)) {
        Refusal::unsupported(why)
    } else {
        Refusal::invalid(why)
    }
}

/// One forward directive of a host, as its own connection. `behind_jump` is
/// whether the host goes through a `ProxyJump`: a forward's SSH server is
/// its first hop, so that cannot be expressed.
fn forward_connection(
    alias: &str,
    value: &Value,
    flavor: ForwardFlavor,
    server: &ServerPlan,
    route: &Route,
) -> Result<PlannedConnection, Refusal> {
    if matches!(route, Route::Jump(_)) {
        return Err(Refusal::unsupported(format!(
            "{} on {} goes through a ProxyJump, and SSIX forwards only from a host it reaches directly",
            value.keyword, value.at
        )));
    }
    let args = value
        .args
        .as_ref()
        .map_err(|why| Refusal::invalid(why.clone()))?;
    let located = |why: String| format!("{} on {}: {why}", value.keyword, value.at);

    let listen_arg = args.first().map(String::as_str).unwrap_or_default();
    let destination_arg = match flavor {
        ForwardFlavor::Dynamic => {
            if args.len() != 1 {
                return Err(Refusal::invalid(located(
                    "it takes [address:]port".to_string(),
                )));
            }
            None
        }
        ForwardFlavor::Remote if args.len() == 1 => {
            return Err(Refusal::unsupported(located(
                "no destination makes this a reverse SOCKS proxy, which SSIX cannot set up"
                    .to_string(),
            )));
        }
        ForwardFlavor::Local | ForwardFlavor::Remote => {
            if args.len() != 2 {
                return Err(Refusal::invalid(located(
                    "it takes [address:]port and host:port".to_string(),
                )));
            }
            Some(args[1].as_str())
        }
    };

    let listen =
        parse_forward_end(listen_arg).map_err(|why| forward_refusal(args, located(why)))?;
    let destination = destination_arg
        .map(|arg| {
            let end = parse_forward_end(arg).map_err(|why| forward_refusal(args, located(why)))?;
            match end.host {
                Some(host) if valid_host(&host) => Ok((host, end.port)),
                _ => Err(Refusal::invalid(located(format!(
                    "'{arg}' does not name a host and port"
                )))),
            }
        })
        .transpose()?;

    let mut notes = server.notes.clone();
    if let Some(bind) = &listen.host {
        match flavor {
            ForwardFlavor::Remote => notes.push(format!(
                "The bind address {bind} is dropped: the SSH server chooses where it listens"
            )),
            _ if bind != "127.0.0.1" && bind != "localhost" => notes.push(format!(
                "The bind address {bind} is dropped: SSIX listens on 127.0.0.1 only"
            )),
            _ => {}
        }
    }

    let gateway_host = server.host.clone();
    let gateway_port = server.port;
    let gateway_credential_id = String::new();
    let (flag, kind, summary) = match (flavor, destination) {
        (ForwardFlavor::Local, Some((destination_host, destination_port))) => (
            "-L",
            ConnectionKind::PortForward {
                gateway_host,
                gateway_port,
                gateway_credential_id,
                local_port: listen.port,
                destination_host: destination_host.clone(),
                destination_port,
            },
            format!(
                "127.0.0.1:{} → {destination_host}:{destination_port}",
                listen.port
            ),
        ),
        (ForwardFlavor::Remote, Some((destination_host, destination_port))) => (
            "-R",
            ConnectionKind::RemoteForward {
                gateway_host,
                gateway_port,
                gateway_credential_id,
                remote_port: listen.port,
                destination_host: destination_host.clone(),
                destination_port,
            },
            format!(
                "remote port {} → {destination_host}:{destination_port}",
                listen.port
            ),
        ),
        _ => (
            "-D",
            ConnectionKind::DynamicForward {
                gateway_host,
                gateway_port,
                gateway_credential_id,
                local_port: listen.port,
            },
            format!("127.0.0.1:{} (SOCKS)", listen.port),
        ),
    };
    // The same fields a form-made forward has: its far end when it has one,
    // otherwise its SSH server (`mirroredEndpoint` in the connection form).
    let (host, port) = match &kind {
        ConnectionKind::PortForward {
            destination_host,
            destination_port,
            ..
        }
        | ConnectionKind::RemoteForward {
            destination_host,
            destination_port,
            ..
        } => (destination_host.clone(), *destination_port),
        _ => (server.host.clone(), server.port),
    };
    Ok(PlannedConnection {
        name: format!("{alias} ({flag} {})", listen.port),
        source: value.at.clone(),
        host,
        port,
        kind,
        target_credential: None,
        gateway_credential: Some(server.credential.clone()),
        proxy_command: match route {
            Route::Command(command) => Some(command.clone()),
            Route::Direct | Route::Jump(_) => None,
        },
        summary: format!("{summary} on {}", server.address()),
        notes,
    })
}

/// Everything one literal `Host` name asks for: the host itself and one
/// connection per forward.
fn plan_alias(
    config: &ParsedConfig,
    env: &ImportEnv,
    alias: &str,
    at: &Source,
) -> Vec<Result<PlannedConnection, ImportSkip>> {
    if alias.chars().count() > MAX_NAME_CHARS {
        let shown: String = alias.chars().take(40).collect();
        let refusal = Refusal::invalid(format!(
            "The name is longer than {MAX_NAME_CHARS} characters"
        ));
        return vec![Err(refusal.skip(&format!("{shown}…"), at))];
    }
    let resolved = config.resolve(alias);
    if !resolved.named {
        let refusal = Refusal::unsupported(
            "No Host block applies to it: it is negated, or in an Include inside another host's block",
        );
        return vec![Err(refusal.skip(alias, at))];
    }
    let (server, route) = match (
        server_plan(env, alias, &resolved, None, None),
        route(env, config, alias, &resolved),
    ) {
        (Ok(server), Ok(route)) => (server, route),
        (Err(refusal), _) | (_, Err(refusal)) => return vec![Err(refusal.skip(alias, at))],
    };

    let mut planned = vec![Ok(main_connection(alias, at, &server, &route))];
    for (values, flavor) in [
        (&resolved.local_forwards, ForwardFlavor::Local),
        (&resolved.remote_forwards, ForwardFlavor::Remote),
        (&resolved.dynamic_forwards, ForwardFlavor::Dynamic),
    ] {
        for value in values {
            planned.push(
                forward_connection(alias, value, flavor, &server, &route).map_err(|refusal| {
                    refusal.skip(&format!("{alias} ({})", value.keyword), &value.at)
                }),
            );
        }
    }
    planned
}

fn kind_name(kind: &ConnectionKind) -> &'static str {
    match kind {
        ConnectionKind::Direct => "direct",
        ConnectionKind::PortForward { .. } => "port_forward",
        ConnectionKind::JumpShell { .. } => "jump_shell",
        ConnectionKind::RemoteForward { .. } => "remote_forward",
        ConnectionKind::DynamicForward { .. } => "dynamic_forward",
        ConnectionKind::LegacyTunnel { .. } => "tunnel",
    }
}

/// A planned connection the user can pick.
struct PlanItem {
    planned: PlannedConnection,
    key: String,
    target_credential_name: Option<String>,
    gateway_credential_name: Option<String>,
    credentials: Vec<ImportCredentialPlan>,
}

#[derive(Default)]
struct Plan {
    items: Vec<PlanItem>,
    skipped: Vec<ImportSkip>,
    notices: Vec<ImportNotice>,
}

/// Connections the plan must not repeat: those stored, and those it has
/// admitted so far. Indexed because a large config compares every host
/// against all of them.
#[derive(Default)]
struct KnownConnections {
    /// Trimmed name to its destination, and whether it is stored.
    by_name: HashMap<String, (String, bool)>,
    /// Destination to the first name that has it, and whether that is stored.
    by_destination: HashMap<String, (String, bool)>,
}

impl KnownConnections {
    fn of(data: &AppData) -> Self {
        let mut known = Self::default();
        for connection in &data.connections {
            let destination = connection_signature(connection, &data.credentials).to_string();
            known.add(connection.name.trim(), destination, true);
        }
        known
    }

    fn add(&mut self, name: &str, destination: String, stored: bool) {
        self.by_destination
            .entry(destination.clone())
            .or_insert_with(|| (name.to_string(), stored));
        self.by_name
            .entry(name.to_string())
            .or_insert((destination, stored));
    }

    /// Why `planned` must not be created.
    fn conflict(&self, planned: &PlannedConnection) -> Option<Refusal> {
        let wanted = planned.signature().to_string();
        let refuse = |category, reason: String| Some(Refusal { category, reason });
        if let Some((destination, stored)) = self.by_name.get(&planned.name) {
            return match (*stored, *destination == wanted) {
                (true, true) => refuse(
                    ImportSkipCategory::AlreadyImported,
                    "Already in SSIX".to_string(),
                ),
                (true, false) => refuse(
                    ImportSkipCategory::NameClash,
                    format!(
                        "A connection named '{}' already exists with another destination. It stays as it is; rename it or the Host to import this one",
                        planned.name
                    ),
                ),
                (false, _) => refuse(
                    ImportSkipCategory::Duplicate,
                    "An earlier entry in this config uses the same name".to_string(),
                ),
            };
        }
        let (twin, stored) = self.by_destination.get(&wanted)?;
        if *stored {
            refuse(
                ImportSkipCategory::AlreadyImported,
                format!("Already in SSIX as '{twin}'"),
            )
        } else {
            refuse(
                ImportSkipCategory::Duplicate,
                format!("Same destination as '{twin}' above"),
            )
        }
    }
}

impl Plan {
    /// Try `planned` against `scratch`, the stored data plus what this plan
    /// has admitted, through the same checks a real save runs.
    fn admit(
        &mut self,
        planned: PlannedConnection,
        data: &AppData,
        scratch: &mut AppData,
        known: &mut KnownConnections,
    ) {
        if let Some(refusal) = known.conflict(&planned) {
            self.skipped
                .push(refusal.skip(&planned.name, &planned.source));
            return;
        }
        let credentials_before = scratch.credentials.len();
        let mut credentials = Vec::new();
        let mut resolve = |scratch: &mut AppData,
                           spec: &Option<CredentialSpec>,
                           role: &str|
         -> Result<(Option<String>, Option<String>), String> {
            let Some(spec) = spec else {
                return Ok((None, None));
            };
            let name = planned_credential_name(&scratch.credentials, spec);
            let id = ensure_credential(scratch, spec, &name)?;
            credentials.push(ImportCredentialPlan {
                role: role.to_string(),
                name: name.clone(),
                username: spec.username.clone(),
                private_key_path: spec.key_path.clone(),
                exists: spec.find_in(&data.credentials).is_some(),
            });
            Ok((Some(id), Some(name)))
        };
        let two_hop_is_forward = planned.kind.is_forward();
        let outcome = resolve(
            scratch,
            &planned.gateway_credential,
            if two_hop_is_forward {
                "SSH server credential"
            } else {
                "Jump host credential"
            },
        )
        .and_then(|(gateway_id, gateway_name)| {
            let role = if gateway_id.is_some() {
                "Target credential"
            } else {
                "Credential"
            };
            let (target_id, target_name) = resolve(scratch, &planned.target_credential, role)?;
            let mut fields = planned.fields(target_id, gateway_id);
            check_connection(scratch, &mut fields, None)?;
            insert_new_connection(scratch, fields);
            Ok((target_name, gateway_name))
        });
        match outcome {
            Ok((target_credential_name, gateway_credential_name)) => {
                known.add(&planned.name, planned.signature().to_string(), false);
                self.items.push(PlanItem {
                    key: planned.key(),
                    planned,
                    target_credential_name,
                    gateway_credential_name,
                    credentials,
                });
            }
            Err(reason) => {
                scratch.credentials.truncate(credentials_before);
                self.skipped
                    .push(Refusal::invalid(reason).skip(&planned.name, &planned.source));
            }
        }
    }

    fn into_preview(self, config: &ParsedConfig, path: String) -> ImportPreview {
        let notices = config
            .notices
            .iter()
            .map(|notice| ImportNotice {
                message: notice.message.clone(),
                source: notice.source.to_string(),
            })
            .chain(self.notices)
            .collect();
        ImportPreview {
            path,
            files: config.files.clone(),
            items: self
                .items
                .into_iter()
                .map(|item| ImportItem {
                    key: item.key,
                    kind: kind_name(&item.planned.kind).to_string(),
                    source: item.planned.source.to_string(),
                    name: item.planned.name,
                    target: item.planned.summary,
                    credentials: item.credentials,
                    proxy_command: item.planned.proxy_command,
                    notes: item.planned.notes,
                })
                .collect(),
            skipped: self.skipped,
            notices,
        }
    }
}

/// Decide what importing `config` over `data` would do. Pure: the result
/// comes from a scratch copy that is thrown away.
fn build_plan(config: &ParsedConfig, data: &AppData, env: &ImportEnv) -> Plan {
    let mut scratch = data.clone();
    let mut known = KnownConnections::of(data);
    let mut plan = Plan::default();
    let mut hosts = 0;
    for entry in config.host_entries() {
        match entry {
            HostEntry::Pattern { pattern, at } => {
                let reason = if pattern == "*" {
                    "Supplies defaults for the hosts above and below it, not a host of its own"
                } else {
                    "A pattern, not a single host: it supplies options to the hosts it matches"
                };
                plan.skipped.push(ImportSkip {
                    name: pattern,
                    category: ImportSkipCategory::Pattern,
                    reason: reason.to_string(),
                    source: at.to_string(),
                });
            }
            HostEntry::Alias { name, at } => {
                hosts += 1;
                if hosts > MAX_HOSTS {
                    if hosts == MAX_HOSTS + 1 {
                        plan.notices.push(ImportNotice {
                            message: format!("Hosts after the first {MAX_HOSTS} were not read"),
                            source: at.to_string(),
                        });
                    }
                    continue;
                }
                for outcome in plan_alias(config, env, &name, &at) {
                    match outcome {
                        Ok(planned) => plan.admit(planned, data, &mut scratch, &mut known),
                        Err(skip) => plan.skipped.push(skip),
                    }
                }
            }
        }
    }
    plan
}

fn read_config(path: Option<&str>, env: &ImportEnv) -> Result<(ParsedConfig, String), String> {
    let path = config_path(path, &env.home)?;
    let config = ParsedConfig::read(&path, &env.home)?;
    Ok((config, display_path(&path, &env.home)))
}

fn preview_sync(path: Option<&str>, env: &ImportEnv) -> Result<ImportPreview, String> {
    let (config, shown) = read_config(path, env)?;
    let data = load_data()?;
    Ok(build_plan(&config, &data, env).into_preview(&config, shown))
}

fn apply_sync(input: &ImportApplyInput, env: &ImportEnv) -> Result<ImportResult, String> {
    if input.keys.is_empty() {
        return Err("Choose at least one host to import".to_string());
    }
    // Read before taking the data lock: an include may be slow to open.
    let (config, _) = read_config(input.path.as_deref(), env)?;
    let selected: HashSet<&str> = input.keys.iter().map(String::as_str).collect();
    // One transaction: anything refused below saves nothing at all.
    with_data_mut(|data| {
        let plan = build_plan(&config, data, env);
        let planned: HashSet<&str> = plan.items.iter().map(|item| item.key.as_str()).collect();
        if !selected.is_subset(&planned) {
            return Err(STALE_PREVIEW.to_string());
        }
        let mut result = ImportResult::default();
        for item in plan
            .items
            .iter()
            .filter(|item| selected.contains(item.key.as_str()))
        {
            let credentials_before = data.credentials.len();
            let mut credential_id =
                |spec: &Option<CredentialSpec>, name: &Option<String>| match (spec, name) {
                    (Some(spec), Some(name)) => ensure_credential(data, spec, name).map(Some),
                    _ => Ok(None),
                };
            let target_id = credential_id(
                &item.planned.target_credential,
                &item.target_credential_name,
            )?;
            let gateway_id = credential_id(
                &item.planned.gateway_credential,
                &item.gateway_credential_name,
            )?;
            let mut fields = item.planned.fields(target_id, gateway_id);
            check_connection(data, &mut fields, None)?;
            result
                .connections
                .push(insert_new_connection(data, fields).name);
            result.credentials.extend(
                data.credentials[credentials_before..]
                    .iter()
                    .map(|credential| credential.name.clone()),
            );
        }
        Ok(result)
    })
}

/// Report what importing the file at `path` (default `~/.ssh/config`) would
/// do. Writes nothing.
#[tauri::command]
pub async fn import_ssh_config_preview(path: Option<String>) -> Result<ImportPreview, String> {
    blocking(move || preview_sync(path.as_deref(), &ImportEnv::current()?)).await
}

/// Store the items of a preview the user picked. All of them or, if any is
/// refused, none.
#[tauri::command]
pub async fn import_ssh_config_apply(input: ImportApplyInput) -> Result<ImportResult, String> {
    blocking(move || apply_sync(&input, &ImportEnv::current()?)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_config::test_support::TempHome;
    use crate::storage::test_support::with_isolated_data_dir;

    struct Fixture {
        home: TempHome,
        env: ImportEnv,
    }

    impl Fixture {
        fn new() -> Self {
            let home = TempHome::new();
            let env = ImportEnv {
                home: home.0.clone(),
                local_user: Some("localme".to_string()),
            };
            Self { home, env }
        }

        fn write_config(&self, text: &str) -> String {
            let path = self.home.write(".ssh/config", text);
            path.to_string_lossy().into_owned()
        }

        fn preview(&self, text: &str) -> ImportPreview {
            let path = self.write_config(text);
            preview_sync(Some(&path), &self.env).unwrap()
        }

        fn apply_all(&self, preview: &ImportPreview) -> ImportResult {
            let keys = preview.items.iter().map(|i| i.key.clone()).collect();
            self.apply(keys).unwrap()
        }

        fn apply(&self, keys: Vec<String>) -> Result<ImportResult, String> {
            let path = self
                .home
                .0
                .join(".ssh/config")
                .to_string_lossy()
                .into_owned();
            apply_sync(
                &ImportApplyInput {
                    path: Some(path),
                    keys,
                },
                &self.env,
            )
        }

        fn import(&self, text: &str) -> ImportResult {
            let preview = self.preview(text);
            self.apply_all(&preview)
        }

        fn key_path(&self, relative: &str) -> String {
            self.home.0.join(relative).to_string_lossy().into_owned()
        }
    }

    fn in_data_dir(test: impl FnOnce(Fixture)) {
        with_isolated_data_dir(|| test(Fixture::new()));
    }

    fn item<'a>(preview: &'a ImportPreview, name: &str) -> &'a ImportItem {
        preview
            .items
            .iter()
            .find(|i| i.name == name)
            .unwrap_or_else(|| panic!("no item {name}: {preview:#?}"))
    }

    fn skip<'a>(preview: &'a ImportPreview, name: &str) -> &'a ImportSkip {
        preview
            .skipped
            .iter()
            .find(|s| s.name == name)
            .unwrap_or_else(|| panic!("no skip {name}: {preview:#?}"))
    }

    fn names(preview: &ImportPreview) -> Vec<&str> {
        preview.items.iter().map(|i| i.name.as_str()).collect()
    }

    fn stored(name: &str) -> Connection {
        load_data()
            .unwrap()
            .connections
            .into_iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("no connection {name}"))
    }

    fn credential_of(id: &str) -> Credential {
        load_data()
            .unwrap()
            .credentials
            .into_iter()
            .find(|c| c.id == id)
            .unwrap_or_else(|| panic!("no credential {id}"))
    }

    const BASIC: &str =
        "Host web\n  HostName 10.0.0.1\n  Port 2200\n  User deploy\n  IdentityFile ~/.ssh/id_web\n";

    #[test]
    fn config_path_defaults_and_expands() {
        let home = Path::new("/home/u");
        assert_eq!(
            config_path(None, home).unwrap(),
            PathBuf::from("/home/u/.ssh/config")
        );
        assert_eq!(
            config_path(Some("  "), home).unwrap(),
            PathBuf::from("/home/u/.ssh/config")
        );
        assert_eq!(
            config_path(Some("~/work/config"), home).unwrap(),
            PathBuf::from("/home/u/work/config")
        );
        assert_eq!(
            config_path(Some("/etc/ssh/ssh_config"), home).unwrap(),
            PathBuf::from("/etc/ssh/ssh_config")
        );
        assert!(config_path(Some("relative/config"), home).is_err());
        assert!(config_path(Some("~other/config"), home).is_err());
    }

    #[test]
    fn a_missing_config_is_a_clear_error() {
        in_data_dir(|f| {
            let error = preview_sync(None, &f.env).unwrap_err();
            assert!(error.contains("~/.ssh/config does not exist"), "{error}");
        });
    }

    #[test]
    fn preview_writes_nothing() {
        in_data_dir(|f| {
            let preview = f.preview(BASIC);
            assert_eq!(names(&preview), ["web"]);
            assert!(!crate::storage::get_data_path().exists());
            assert!(!crate::keychain::secrets_path().exists());
        });
    }

    #[test]
    fn a_full_host_becomes_a_direct_connection_and_a_path_only_credential() {
        in_data_dir(|f| {
            let preview = f.preview(BASIC);
            let web = item(&preview, "web");
            assert_eq!(web.kind, "direct");
            assert_eq!(web.target, "deploy@10.0.0.1:2200");
            assert_eq!(web.source, "~/.ssh/config:1");
            assert_eq!(web.credentials.len(), 1);
            assert_eq!(web.credentials[0].role, "Credential");
            assert_eq!(web.credentials[0].name, "deploy@id_web");
            assert_eq!(
                web.credentials[0].private_key_path.as_deref(),
                Some(f.key_path(".ssh/id_web").as_str())
            );
            assert!(!web.credentials[0].exists);
            assert!(web.notes.is_empty());

            let result = f.apply_all(&preview);
            assert_eq!(result.connections, ["web"]);
            assert_eq!(result.credentials, ["deploy@id_web"]);

            let connection = stored("web");
            assert_eq!(connection.host, "10.0.0.1");
            assert_eq!(connection.port, 2200);
            assert_eq!(connection.kind, ConnectionKind::Direct);
            let credential = credential_of(connection.credential_id.as_deref().unwrap());
            assert_eq!(credential.username, "deploy");
            assert!(!credential.is_private);
            assert_eq!(
                credential.kind,
                CredentialKind::SshKey {
                    private_key_path: Some(f.key_path(".ssh/id_web")),
                    private_key: None,
                    passphrase: None,
                }
            );
        });
    }

    #[test]
    fn key_contents_are_never_read() {
        in_data_dir(|f| {
            f.home
                .write(".ssh/id_web", "-----BEGIN SENTINEL KEY CONTENTS-----");
            f.import(BASIC);
            let data = std::fs::read_to_string(crate::storage::get_data_path()).unwrap();
            assert!(data.contains("id_web"));
            assert!(!data.contains("SENTINEL"));
            // A path-only credential has nothing to put in the secrets file.
            assert!(!crate::keychain::secrets_path().exists());
        });
    }

    #[test]
    fn host_star_defaults_and_first_value_wins_reach_the_connection() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host web\n  User deploy\nHost db\n  Port 5022\nHost *\n  User shared\n  Port 2200\n  IdentityFile ~/.ssh/shared\n",
            );
            assert_eq!(item(&preview, "web").target, "deploy@web:2200");
            assert_eq!(item(&preview, "db").target, "shared@db:5022");
            assert_eq!(
                skip(&preview, "*").category,
                ImportSkipCategory::Pattern,
                "Host * is reported, not imported"
            );
        });
    }

    #[test]
    fn host_name_expands_h() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host a b\n  HostName %h.example.com\n  User u\n  IdentityFile ~/.ssh/id\nHost odd\n  HostName %x\n  User u\n",
            );
            assert_eq!(item(&preview, "a").target, "u@a.example.com:22");
            assert_eq!(item(&preview, "b").target, "u@b.example.com:22");
            assert_eq!(
                skip(&preview, "odd").category,
                ImportSkipCategory::Unsupported
            );
        });
    }

    #[test]
    fn no_identity_file_uses_the_agent_and_says_so() {
        in_data_dir(|f| {
            let preview = f.preview("Host web\n  User deploy\n");
            let web = item(&preview, "web");
            assert_eq!(web.credentials[0].private_key_path, None);
            assert_eq!(web.credentials[0].name, "deploy (agent)");
            assert!(
                web.notes.iter().any(|n| n.contains("SSH agent")),
                "{:?}",
                web.notes
            );

            f.apply_all(&preview);
            let credential = credential_of(stored("web").credential_id.as_deref().unwrap());
            assert_eq!(credential.kind, CredentialKind::Agent {});
            assert_eq!(credential.username, "deploy");
        });
    }

    #[test]
    fn no_user_uses_the_login_name_and_says_so() {
        in_data_dir(|f| {
            let preview = f.preview("Host nas\n  HostName 192.168.1.10\n");
            let nas = item(&preview, "nas");
            assert_eq!(nas.target, "localme@192.168.1.10:22");
            assert!(
                nas.notes.iter().any(|n| n.contains("login name")),
                "{:?}",
                nas.notes
            );
        });
    }

    #[test]
    fn no_user_and_no_login_name_is_skipped() {
        in_data_dir(|mut f| {
            f.env.local_user = None;
            let preview = f.preview("Host nas\n");
            let nas = skip(&preview, "nas");
            assert_eq!(nas.category, ImportSkipCategory::Unsupported);
            assert!(nas.reason.contains("no User"), "{}", nas.reason);
            assert!(preview.items.is_empty());
        });
    }

    #[test]
    fn identity_file_tokens_and_paths() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host a\n  User u\n  IdentityFile %d/.ssh/%h-%r-%p-%n-%u\nHost none-first\n  User u\n  IdentityFile none\n  IdentityFile ~/.ssh/second\nHost many\n  User u\n  IdentityFile ~/.ssh/one\n  IdentityFile ~/.ssh/two\nHost relative\n  User u\n  IdentityFile id_rsa\nHost token\n  User u\n  IdentityFile ~/.ssh/%C\nHost other-home\n  User u\n  IdentityFile ~bob/id\nHost quoted\n  User u\n  IdentityFile \"~/my keys/id\"\n",
            );
            assert_eq!(
                item(&preview, "a").credentials[0]
                    .private_key_path
                    .as_deref(),
                Some(f.key_path(".ssh/a-u-22-a-localme").as_str())
            );
            assert_eq!(
                item(&preview, "none-first").credentials[0]
                    .private_key_path
                    .as_deref(),
                Some(f.key_path(".ssh/second").as_str())
            );
            let many = item(&preview, "many");
            assert_eq!(
                many.credentials[0].private_key_path.as_deref(),
                Some(f.key_path(".ssh/one").as_str())
            );
            assert!(many.notes.iter().any(|n| n.contains("uses the first")));
            assert_eq!(
                item(&preview, "quoted").credentials[0]
                    .private_key_path
                    .as_deref(),
                Some(f.key_path("my keys/id").as_str())
            );
            assert!(skip(&preview, "relative").reason.contains("relative"));
            assert!(skip(&preview, "token").reason.contains("%C"));
            assert!(skip(&preview, "other-home").reason.contains("~user"));
        });
    }

    #[test]
    fn proxy_jump_through_a_resolved_host_becomes_a_jump_connection() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host target\n  HostName 10.1.0.5\n  User app\n  IdentityFile ~/.ssh/app\n  ProxyJump bastion\nHost bastion\n  HostName jump.example.com\n  Port 2222\n  User ops\n  IdentityFile ~/.ssh/ops\n",
            );
            let target = item(&preview, "target");
            assert_eq!(target.kind, "jump_shell");
            assert_eq!(
                target.target,
                "app@10.1.0.5:22 through ops@jump.example.com:2222"
            );
            let roles: Vec<&str> = target.credentials.iter().map(|c| c.role.as_str()).collect();
            assert_eq!(roles, ["Jump host credential", "Target credential"]);

            f.apply_all(&preview);
            let connection = stored("target");
            assert_eq!(connection.host, "10.1.0.5");
            match &connection.kind {
                ConnectionKind::JumpShell {
                    gateway_host,
                    gateway_port,
                    gateway_credential_id,
                    destination_host,
                    destination_port,
                } => {
                    assert_eq!(gateway_host, "jump.example.com");
                    assert_eq!(*gateway_port, 2222);
                    assert_eq!(destination_host, "10.1.0.5");
                    assert_eq!(*destination_port, 22);
                    assert_eq!(credential_of(gateway_credential_id).username, "ops");
                }
                other => panic!("expected a jump connection, got {other:?}"),
            }
            let target_credential = credential_of(connection.credential_id.as_deref().unwrap());
            assert_eq!(target_credential.username, "app");
            // The jump host is also a host of its own.
            assert_eq!(stored("bastion").kind, ConnectionKind::Direct);
        });
    }

    #[test]
    fn proxy_jump_explicit_parts_win_and_a_literal_host_resolves() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host a\n  User app\n  ProxyJump root@bastion:2200\nHost bastion\n  Port 9\n  User ops\n  IdentityFile ~/.ssh/ops\nHost b\n  User app\n  ProxyJump ssh://svc@jump.example.com\n",
            );
            assert_eq!(
                item(&preview, "a").target,
                "app@a:22 through root@bastion:2200"
            );
            let b = item(&preview, "b");
            assert_eq!(b.target, "app@b:22 through svc@jump.example.com:22");
            assert!(
                b.notes.iter().any(|n| n.starts_with("Jump host: ")),
                "{:?}",
                b.notes
            );
        });
    }

    #[test]
    fn proxy_jump_beyond_one_resolvable_hop_is_reported() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host two\n  User u\n  ProxyJump a,b\nHost chained\n  User u\n  ProxyJump mid\nHost mid\n  User u\n  ProxyJump far\nHost far\n  User u\nHost through-cmd\n  User u\n  ProxyJump cmdhop\nHost cmdhop\n  User u\n  ProxyCommand nc %h %p\nHost selfie\n  User u\n  ProxyJump selfie\nHost bad\n  User u\n  ProxyJump a:b:c:d\nHost badhop\n  User u\n  ProxyJump brokenport\nHost brokenport\n  Port nope\n",
            );
            let two = skip(&preview, "two");
            assert_eq!(two.category, ImportSkipCategory::Unsupported);
            assert!(two.reason.contains("2 hops"), "{}", two.reason);
            assert!(skip(&preview, "chained")
                .reason
                .contains("mid goes through"));
            assert!(skip(&preview, "through-cmd")
                .reason
                .contains("cmdhop goes through"));
            assert!(skip(&preview, "selfie").reason.contains("itself"));
            assert_eq!(skip(&preview, "bad").category, ImportSkipCategory::Invalid);
            let bad_hop = skip(&preview, "badhop");
            assert!(
                bad_hop.reason.starts_with("Jump host brokenport:"),
                "{}",
                bad_hop.reason
            );
            // `mid` itself is one hop and resolvable.
            assert_eq!(item(&preview, "mid").kind, "jump_shell");
        });
    }

    #[test]
    fn proxy_none_overrides_a_default() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host bastion\n  User ops\n  ProxyJump none\nHost inner\n  User app\nHost *\n  ProxyJump bastion\n",
            );
            assert_eq!(item(&preview, "bastion").kind, "direct");
            assert_eq!(item(&preview, "inner").kind, "jump_shell");
        });
    }

    #[test]
    fn a_default_proxy_jump_without_none_makes_the_jump_host_a_loop() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host bastion\n  User ops\nHost inner\n  User app\nHost *\n  ProxyJump bastion\n",
            );
            assert!(skip(&preview, "bastion").reason.contains("itself"));
            assert!(skip(&preview, "inner").reason.contains("goes through"));
        });
    }

    #[test]
    fn proxy_command_is_kept_when_it_validates() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host good\n  User u\n  ProxyCommand nc -X connect -x proxy:3128 %h %p\nHost bad-token\n  User u\n  ProxyCommand nc %C\nHost lone\n  User u\n  ProxyCommand nc %\nHost off\n  User u\n  ProxyCommand none\nHost quoted\n  User u\n  ProxyCommand \"unbalanced\n",
            );
            assert_eq!(
                item(&preview, "good").proxy_command.as_deref(),
                Some("nc -X connect -x proxy:3128 %h %p")
            );
            assert_eq!(item(&preview, "off").proxy_command, None);
            let bad = skip(&preview, "bad-token");
            assert_eq!(bad.category, ImportSkipCategory::Unsupported);
            assert!(bad.reason.contains("%C"), "{}", bad.reason);
            assert!(skip(&preview, "lone").reason.contains("lone %"));
            assert_eq!(
                skip(&preview, "quoted").category,
                ImportSkipCategory::Invalid
            );

            f.apply_all(&preview);
            assert_eq!(
                stored("good").proxy_command.as_deref(),
                Some("nc -X connect -x proxy:3128 %h %p")
            );
        });
    }

    #[test]
    fn forwards_become_connections_of_their_own() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host web\n  HostName 10.0.0.1\n  Port 2200\n  User deploy\n  IdentityFile ~/.ssh/id\n  LocalForward 8080 db:5432\n  RemoteForward 9000 localhost:3000\n  DynamicForward 1080\n",
            );
            assert_eq!(
                names(&preview),
                ["web", "web (-L 8080)", "web (-R 9000)", "web (-D 1080)"]
            );
            let local = item(&preview, "web (-L 8080)");
            assert_eq!(local.kind, "port_forward");
            assert_eq!(
                local.target,
                "127.0.0.1:8080 → db:5432 on deploy@10.0.0.1:2200"
            );
            assert_eq!(local.credentials[0].role, "SSH server credential");
            assert_eq!(item(&preview, "web (-R 9000)").kind, "remote_forward");
            assert_eq!(item(&preview, "web (-D 1080)").kind, "dynamic_forward");

            let result = f.apply_all(&preview);
            assert_eq!(result.connections.len(), 4);
            // All four share the host's one credential.
            assert_eq!(result.credentials.len(), 1);

            let web = stored("web");
            let shared = web.credential_id.clone().unwrap();
            let local = stored("web (-L 8080)");
            assert_eq!((local.host.as_str(), local.port), ("db", 5432));
            assert_eq!(local.credential_id, None);
            assert_eq!(
                local.kind,
                ConnectionKind::PortForward {
                    gateway_host: "10.0.0.1".to_string(),
                    gateway_port: 2200,
                    gateway_credential_id: shared.clone(),
                    local_port: 8080,
                    destination_host: "db".to_string(),
                    destination_port: 5432,
                }
            );
            let remote = stored("web (-R 9000)");
            assert_eq!((remote.host.as_str(), remote.port), ("localhost", 3000));
            assert_eq!(
                remote.kind,
                ConnectionKind::RemoteForward {
                    gateway_host: "10.0.0.1".to_string(),
                    gateway_port: 2200,
                    gateway_credential_id: shared.clone(),
                    remote_port: 9000,
                    destination_host: "localhost".to_string(),
                    destination_port: 3000,
                }
            );
            let dynamic = stored("web (-D 1080)");
            assert_eq!((dynamic.host.as_str(), dynamic.port), ("10.0.0.1", 2200));
            assert_eq!(
                dynamic.kind,
                ConnectionKind::DynamicForward {
                    gateway_host: "10.0.0.1".to_string(),
                    gateway_port: 2200,
                    gateway_credential_id: shared,
                    local_port: 1080,
                }
            );
        });
    }

    #[test]
    fn a_forward_inherits_the_proxy_command_of_its_host() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host web\n  User u\n  ProxyCommand nc %h %p\n  LocalForward 8080 db:5432\n",
            );
            assert_eq!(
                item(&preview, "web (-L 8080)").proxy_command.as_deref(),
                Some("nc %h %p")
            );
        });
    }

    #[test]
    fn a_forward_behind_proxy_jump_is_reported_and_the_host_stays() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host web\n  User u\n  ProxyJump bastion\n  LocalForward 8080 db:5432\nHost bastion\n  User u\n",
            );
            assert_eq!(item(&preview, "web").kind, "jump_shell");
            let forward = skip(&preview, "web (LocalForward)");
            assert_eq!(forward.category, ImportSkipCategory::Unsupported);
            assert!(forward.reason.contains("ProxyJump"), "{}", forward.reason);
            assert_eq!(forward.source, "~/.ssh/config:4");
        });
    }

    #[test]
    fn forwards_ssix_cannot_represent_are_reported_one_by_one() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host web\n  User u\n  LocalForward /tmp/sock db:5432\n  LocalForward 1 /tmp/sock\n  RemoteForward 9000\n  LocalForward 2\n  LocalForward nope db:1\n  LocalForward 3 db\n  LocalForward 4 db:0\n  LocalForward 5 :80\n  LocalForward 6 a;b:80\n  DynamicForward 7 8\n  LocalForward 70000 db:1\n  RemoteForward \"9\n  LocalForward 8080 db:5432\n",
            );
            assert_eq!(names(&preview), ["web", "web (-L 8080)"]);
            let local: Vec<&ImportSkip> = preview
                .skipped
                .iter()
                .filter(|s| s.name == "web (LocalForward)")
                .collect();
            assert_eq!(local.len(), 9);
            assert_eq!(local[0].category, ImportSkipCategory::Unsupported);
            assert!(local[0].reason.contains("Unix socket"));
            assert_eq!(local[1].category, ImportSkipCategory::Unsupported);
            assert!(local[2..]
                .iter()
                .all(|s| s.category == ImportSkipCategory::Invalid));
            let remote: Vec<&ImportSkip> = preview
                .skipped
                .iter()
                .filter(|s| s.name == "web (RemoteForward)")
                .collect();
            assert_eq!(remote.len(), 2);
            assert!(remote[0].reason.contains("reverse SOCKS"));
            assert_eq!(remote[0].category, ImportSkipCategory::Unsupported);
            assert_eq!(remote[1].category, ImportSkipCategory::Invalid);
            assert_eq!(
                skip(&preview, "web (DynamicForward)").category,
                ImportSkipCategory::Invalid
            );
        });
    }

    #[test]
    fn a_bind_address_that_cannot_be_kept_is_noted() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host web\n  User u\n  IdentityFile ~/.ssh/id\n  LocalForward 127.0.0.1:1 db:1\n  LocalForward localhost:2 db:2\n  LocalForward *:3 db:3\n  LocalForward [::1]:4 db:4\n  DynamicForward 0.0.0.0:5\n  RemoteForward 0.0.0.0:6 db:6\n",
            );
            let noted = |name: &str| !item(&preview, name).notes.is_empty();
            assert!(!noted("web (-L 1)"));
            assert!(!noted("web (-L 2)"));
            assert!(noted("web (-L 3)"));
            assert!(noted("web (-L 4)"));
            assert!(noted("web (-D 5)"));
            assert!(noted("web (-R 6)"));
        });
    }

    #[test]
    fn untrusted_values_are_reported_never_a_panic() {
        in_data_dir(|f| {
            let long = "x".repeat(5000);
            let long_name = "n".repeat(300);
            let text = format!(
                "Host badport\n  Port 99999\nHost notnum\n  Port abc\nHost zero\n  Port 0\nHost twoports\n  Port 22 33\nHost quote\n  Port \"22\nHost longuser\n  User {long}\nHost longkey\n  User u\n  IdentityFile {long}\nHost {long_name}\n  User u\nHost longuser2\n  User {user300}\nHost blank\n  User \"\"\nHost -oProxyCommand=evil\n  User u\nHost shell\n  HostName $(touch${{IFS}}x)\n  User u\nHost pct\n  User %r\nHost fine\n  User u\n  IdentityFile ~/.ssh/id\n",
                user300 = "u".repeat(300),
            );
            let preview = f.preview(&text);
            assert_eq!(names(&preview), ["fine"]);
            for name in [
                "badport",
                "notnum",
                "zero",
                "twoports",
                "quote",
                "longuser",
                "longkey",
                "longuser2",
                "blank",
            ] {
                assert_eq!(
                    skip(&preview, name).category,
                    ImportSkipCategory::Invalid,
                    "{name}"
                );
            }
            assert!(skip(&preview, "badport")
                .reason
                .contains("Port on ~/.ssh/config:2"));
            assert!(skip(&preview, "-oProxyCommand=evil")
                .reason
                .contains("host name"));
            assert!(skip(&preview, "shell").reason.contains("host name"));
            assert_eq!(
                skip(&preview, "pct").category,
                ImportSkipCategory::Unsupported
            );
            // The 300-character name is cut for display.
            let long_entry = preview
                .skipped
                .iter()
                .find(|s| s.name.starts_with("nnn"))
                .unwrap();
            assert!(long_entry.name.chars().count() < 50);
            // The unreadable lines are also listed as notices.
            assert!(preview
                .notices
                .iter()
                .any(|n| n.source == "~/.ssh/config:10"));
        });
    }

    #[test]
    fn arbitrary_configs_never_panic_the_mapping() {
        const PIECES: &[&str] = &[
            "Host ",
            "Match ",
            "HostName ",
            "Port ",
            "User ",
            "IdentityFile ",
            "ProxyJump ",
            "ProxyCommand ",
            "LocalForward ",
            "RemoteForward ",
            "DynamicForward ",
            "\n",
            "\n",
            "\n",
            "\"",
            "'",
            "\\",
            "#",
            "=",
            "*",
            "?",
            "!",
            "%",
            "%h",
            "[",
            "]",
            ":",
            "/",
            "~",
            "~/",
            "@",
            ",",
            " ",
            "\t",
            "é",
            "\u{1F511}",
            "22",
            "web",
            "db",
            "-",
            "none",
            "a:1",
        ];
        let mut state: u64 = 42;
        let mut next = move || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as usize
        };
        let env = ImportEnv {
            home: PathBuf::from("/nonexistent-home"),
            local_user: Some("me".to_string()),
        };
        let data = AppData::default();
        for _ in 0..300 {
            let mut text = String::new();
            for _ in 0..(next() % 60) {
                text.push_str(PIECES[next() % PIECES.len()]);
            }
            let config = ParsedConfig::parse_text(&text, &env.home);
            let plan = build_plan(&config, &data, &env);
            // Whatever was admitted is unique by name.
            let mut seen = HashSet::new();
            assert!(
                plan.items
                    .iter()
                    .all(|i| seen.insert(i.planned.name.clone())),
                "{text:?}"
            );
        }
    }

    #[test]
    fn the_preview_reports_match_blocks_and_patterns() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host web\n  User u\nMatch host web\n  Port 9\nHost *.internal\n  User i\nHost db? !db2\n  User d\n",
            );
            assert_eq!(item(&preview, "web").target, "u@web:22");
            assert_eq!(preview.notices.len(), 1);
            assert!(preview.notices[0].message.contains("Match"));
            assert_eq!(preview.notices[0].source, "~/.ssh/config:3");
            for pattern in ["*.internal", "db?", "!db2"] {
                assert_eq!(
                    skip(&preview, pattern).category,
                    ImportSkipCategory::Pattern
                );
            }
        });
    }

    #[test]
    fn hosts_inside_includes_are_imported_and_files_are_named() {
        in_data_dir(|f| {
            f.home
                .write(".ssh/conf.d/extra", "Host included\n  User u\n");
            let preview = f.preview("Include conf.d/*\nHost main\n  User u\n");
            assert_eq!(names(&preview), ["included", "main"]);
            assert_eq!(preview.files, ["~/.ssh/config", "~/.ssh/conf.d/extra"]);
            assert_eq!(item(&preview, "included").source, "~/.ssh/conf.d/extra:1");
        });
    }

    #[test]
    fn a_host_only_in_a_conditional_include_is_skipped_with_a_reason() {
        in_data_dir(|f| {
            f.home.write(".ssh/inner", "Host dead\n  User u\n");
            let preview = f.preview("Host live\n  User u\n  Include inner\n");
            let dead = skip(&preview, "dead");
            assert_eq!(dead.category, ImportSkipCategory::Unsupported);
            assert!(dead.reason.contains("No Host block"), "{}", dead.reason);
        });
    }

    #[test]
    fn importing_the_same_file_twice_creates_no_duplicates() {
        in_data_dir(|f| {
            let text = format!(
                "{BASIC}  LocalForward 8080 db:5432\nHost jumped\n  User app\n  ProxyJump web\n"
            );
            let first = f.import(&text);
            assert_eq!(first.connections.len(), 3);
            let before = load_data().unwrap();

            let again = f.preview(&text);
            assert!(again.items.is_empty(), "{:#?}", again.items);
            for name in ["web", "web (-L 8080)", "jumped"] {
                assert_eq!(
                    skip(&again, name).category,
                    ImportSkipCategory::AlreadyImported,
                    "{name}"
                );
            }
            let after = load_data().unwrap();
            assert_eq!(after.connections.len(), before.connections.len());
            assert_eq!(after.credentials.len(), before.credentials.len());
        });
    }

    #[test]
    fn a_key_from_before_the_first_import_is_refused_once_imported() {
        in_data_dir(|f| {
            let preview = f.preview(BASIC);
            f.apply_all(&preview);
            let error = f.apply(vec![preview.items[0].key.clone()]).unwrap_err();
            assert_eq!(error, STALE_PREVIEW);
            assert_eq!(load_data().unwrap().connections.len(), 1);
        });
    }

    #[test]
    fn a_name_clash_is_shown_and_the_existing_connection_is_left_alone() {
        in_data_dir(|f| {
            f.import("Host web\n  HostName original.example.com\n  User first\n  IdentityFile ~/.ssh/id\n");
            let before = stored("web");

            let preview = f.preview(BASIC);
            assert!(preview.items.is_empty());
            let clash = skip(&preview, "web");
            assert_eq!(clash.category, ImportSkipCategory::NameClash);
            assert!(clash.reason.contains("already exists"), "{}", clash.reason);

            let after = stored("web");
            assert_eq!(after.host, "original.example.com");
            assert_eq!(after.id, before.id);
            assert_eq!(load_data().unwrap().connections.len(), 1);
        });
    }

    #[test]
    fn a_renamed_import_is_still_recognised_by_its_destination() {
        in_data_dir(|f| {
            f.import(BASIC);
            with_data_mut(|data| {
                data.connections[0].name = "my web".to_string();
                Ok(())
            })
            .unwrap();
            let preview = f.preview(BASIC);
            assert!(preview.items.is_empty());
            let web = skip(&preview, "web");
            assert_eq!(web.category, ImportSkipCategory::AlreadyImported);
            assert!(web.reason.contains("'my web'"), "{}", web.reason);
        });
    }

    #[test]
    fn a_connection_with_its_credential_changed_is_still_recognised() {
        in_data_dir(|f| {
            f.import(BASIC);
            with_data_mut(|data| {
                let id = Uuid::new_v4().to_string();
                data.credentials.push(Credential {
                    id: id.clone(),
                    name: "typed by hand".to_string(),
                    username: "deploy".to_string(),
                    kind: CredentialKind::Password {
                        password: String::new(),
                    },
                    is_private: false,
                });
                data.connections[0].credential_id = Some(id);
                Ok(())
            })
            .unwrap();
            let preview = f.preview(BASIC);
            assert_eq!(
                skip(&preview, "web").category,
                ImportSkipCategory::AlreadyImported
            );
        });
    }

    #[test]
    fn aliases_with_one_destination_give_one_connection() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host web web.prod\n  HostName 10.0.0.1\n  User deploy\n  IdentityFile ~/.ssh/id\n",
            );
            assert_eq!(names(&preview), ["web"]);
            let twin = skip(&preview, "web.prod");
            assert_eq!(twin.category, ImportSkipCategory::Duplicate);
            assert!(twin.reason.contains("'web'"), "{}", twin.reason);
        });
    }

    #[test]
    fn aliases_with_their_own_destinations_give_one_connection_each() {
        in_data_dir(|f| {
            let preview = f.preview("Host a b c\n  User deploy\n  IdentityFile ~/.ssh/id\n");
            assert_eq!(names(&preview), ["a", "b", "c"]);
            let result = f.apply_all(&preview);
            assert_eq!(result.connections.len(), 3);
            assert_eq!(result.credentials.len(), 1, "they share the credential");
        });
    }

    #[test]
    fn two_forwards_with_one_name_keep_the_first() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host web\n  User u\n  LocalForward 8080 db:1\n  LocalForward 8080 other:2\n  LocalForward 8080 db:1\n",
            );
            assert_eq!(names(&preview), ["web", "web (-L 8080)"]);
            assert_eq!(
                preview
                    .skipped
                    .iter()
                    .filter(|s| s.category == ImportSkipCategory::Duplicate)
                    .count(),
                2
            );
        });
    }

    #[test]
    fn an_existing_matching_credential_is_shared() {
        in_data_dir(|f| {
            let id = with_data_mut(|data| {
                ensure_credential(
                    data,
                    &CredentialSpec {
                        username: "deploy".to_string(),
                        key_path: Some(f.key_path(".ssh/id_web")),
                    },
                    "my deploy key",
                )
            })
            .unwrap();
            let preview = f.preview(BASIC);
            let plan = &item(&preview, "web").credentials[0];
            assert!(plan.exists);
            assert_eq!(plan.name, "my deploy key");

            let result = f.apply_all(&preview);
            assert!(result.credentials.is_empty());
            assert_eq!(stored("web").credential_id.as_deref(), Some(id.as_str()));
            assert_eq!(load_data().unwrap().credentials.len(), 1);
        });
    }

    #[test]
    fn a_private_credential_is_never_shared() {
        in_data_dir(|f| {
            with_data_mut(|data| {
                data.credentials.push(Credential {
                    id: Uuid::new_v4().to_string(),
                    name: "uuid-name".to_string(),
                    username: "deploy".to_string(),
                    kind: CredentialSpec {
                        username: "deploy".to_string(),
                        key_path: Some(f.key_path(".ssh/id_web")),
                    }
                    .kind(),
                    is_private: true,
                });
                Ok(())
            })
            .unwrap();
            let preview = f.preview(BASIC);
            assert!(!item(&preview, "web").credentials[0].exists);
        });
    }

    #[test]
    fn a_credential_name_clash_gets_a_free_name() {
        in_data_dir(|f| {
            with_data_mut(|data| {
                data.credentials.push(Credential {
                    id: Uuid::new_v4().to_string(),
                    name: "deploy@id_web".to_string(),
                    username: "someone-else".to_string(),
                    kind: CredentialKind::Agent {},
                    is_private: false,
                });
                Ok(())
            })
            .unwrap();
            let preview = f.preview(BASIC);
            assert_eq!(
                item(&preview, "web").credentials[0].name,
                "deploy@id_web (2)"
            );
            let result = f.apply_all(&preview);
            assert_eq!(result.credentials, ["deploy@id_web (2)"]);
        });
    }

    #[test]
    fn a_long_username_still_gets_a_valid_credential_name() {
        in_data_dir(|f| {
            let user = "u".repeat(200);
            let preview = f.preview(&format!("Host web\n  User {user}\n"));
            f.apply_all(&preview);
            let credential = credential_of(stored("web").credential_id.as_deref().unwrap());
            assert!(credential.name.chars().count() <= MAX_NAME_CHARS);
            assert_eq!(credential.username, user);
        });
    }

    #[test]
    fn only_what_was_picked_is_created() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host a\n  User ua\n  IdentityFile ~/.ssh/ida\nHost b\n  User ub\n  IdentityFile ~/.ssh/idb\n",
            );
            let result = f.apply(vec![item(&preview, "b").key.clone()]).unwrap();
            assert_eq!(result.connections, ["b"]);
            assert_eq!(result.credentials, ["ub@idb"]);
            let data = load_data().unwrap();
            assert_eq!(data.connections.len(), 1);
            assert_eq!(
                data.credentials.len(),
                1,
                "no credential for the host left out"
            );
        });
    }

    #[test]
    fn the_config_changing_after_the_preview_refuses_the_whole_import() {
        in_data_dir(|f| {
            let preview = f.preview(BASIC);
            f.write_config(&BASIC.replace("10.0.0.1", "10.6.6.6"));
            let keys = preview.items.iter().map(|i| i.key.clone()).collect();
            assert_eq!(f.apply(keys).unwrap_err(), STALE_PREVIEW);
            assert!(!crate::storage::get_data_path().exists());
        });
    }

    #[test]
    fn a_change_that_leaves_the_picked_items_alone_is_fine() {
        in_data_dir(|f| {
            let preview = f.preview(BASIC);
            f.write_config(&format!("{BASIC}Host added\n  User u\n"));
            let keys = preview.items.iter().map(|i| i.key.clone()).collect();
            let result = f.apply(keys).unwrap();
            assert_eq!(result.connections, ["web"]);
        });
    }

    #[test]
    fn a_key_the_backend_never_planned_refuses_everything() {
        in_data_dir(|f| {
            let preview = f.preview(BASIC);
            let keys = vec![preview.items[0].key.clone(), "forged".to_string()];
            assert_eq!(f.apply(keys).unwrap_err(), STALE_PREVIEW);
            assert!(!crate::storage::get_data_path().exists());
        });
    }

    #[test]
    fn apply_needs_a_selection() {
        in_data_dir(|f| {
            f.write_config(BASIC);
            assert!(f.apply(Vec::new()).unwrap_err().contains("at least one"));
        });
    }

    #[test]
    fn hosts_past_the_limit_are_reported_not_read() {
        in_data_dir(|f| {
            let hosts: String = (0..MAX_HOSTS + 50)
                .map(|i| format!("Host h{i}\n  User u\n  IdentityFile ~/.ssh/id\n"))
                .collect();
            let preview = f.preview(&hosts);
            assert_eq!(preview.items.len(), MAX_HOSTS);
            let notice: Vec<&ImportNotice> = preview
                .notices
                .iter()
                .filter(|n| n.message.contains("were not read"))
                .collect();
            assert_eq!(notice.len(), 1);
            assert_eq!(item(&preview, "h0").credentials[0].name, "u@id");
        });
    }

    #[test]
    fn imported_connections_pass_every_check_a_saved_connection_passes() {
        in_data_dir(|f| {
            f.import(
                "Host web\n  User u\n  IdentityFile ~/.ssh/id\n  LocalForward 1 d:1\n  RemoteForward 2 d:2\n  DynamicForward 3\nHost j\n  User u\n  ProxyJump web\n",
            );
            let data = load_data().unwrap();
            assert_eq!(data.connections.len(), 5);
            for connection in &data.connections {
                let mut fields = ConnectionFields {
                    name: connection.name.clone(),
                    host: connection.host.clone(),
                    port: connection.port,
                    credential_id: connection.credential_id.clone(),
                    kind: connection.kind.clone(),
                    verbosity: 0,
                    extra_args: None,
                    proxy_command: None,
                    login_command: None,
                    remote_path: None,
                    tags: Vec::new(),
                    color: None,
                    advanced: ConnectionAdvanced::default(),
                };
                // As if editing itself, so its own name is not a clash.
                check_connection(&data, &mut fields, Some(&connection.id)).unwrap();
            }
        });
    }
}
