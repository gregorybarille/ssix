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
//!   Of two aliases that end up at the same place, the later one starts
//!   unticked: the user chooses, and neither reserves anything for the other.
//! - No `User`: the login name, which is what `ssh` itself uses.
//! - No `IdentityFile`: an agent credential, the nearest thing to what `ssh`
//!   tries first. Several `IdentityFile`s: the first, because a credential
//!   holds one key. Either way the preview says so.
//! - A key is stored as a path. Its file is never opened here.
//! - A host that cannot be imported faithfully is skipped with its reason;
//!   importing it without its port, proxy or jump host would connect to
//!   something the config does not describe.
//! - A config with a part left out that could change any host (`Match`, an
//!   `Include` that could not be read) cannot promise that of any row, so every
//!   row says so and starts unticked. The user decides, not the default.

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
    valid_host, HostEntry, ParsedConfig, Proxy, ResolvedHost, Source, Value, MAX_FORWARDS_PER_HOST,
};
use crate::storage::{load_data, with_data_mut};

#[cfg(test)]
use ts_rs::TS;

const DEFAULT_CONFIG_PATH: &str = "~/.ssh/config";
const DEFAULT_SSH_PORT: u16 = 22;
/// Hosts one import plans.
const MAX_HOSTS: usize = 2000;
/// What planning may spend on working out hosts, in
/// `ParsedConfig::resolve_steps`. Each host walks the whole file and apply
/// plans while holding the data lock, so hosts times file size must stay
/// bounded, not just each on its own. 2000 hosts of a dozen lines each fit.
const MAX_RESOLVE_STEPS: usize = 50_000_000;
/// Connections one import offers, however many forwards its hosts have.
const MAX_ROWS: usize = 2000;
/// Skipped entries one preview lists. A generated file can hold 100k patterns.
const MAX_SKIPS: usize = 2000;
/// `check_connection`'s limit, tested first so an absurdly long name is not
/// matched against every pattern in the file.
const MAX_NAME_CHARS: usize = 128;
const UNAPPLIED_NOTE: &str = "Part of this config was not applied (see Passed over), so this may not be what ssh does for this host. Check it before ticking it";
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
    /// An earlier entry of this config has the same name. (One with the same
    /// destination is still offered, unticked.)
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
    /// Whether the row starts ticked.
    pub preselected: bool,
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
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
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
        // Room for the " (2)" `CredentialBook::free_name` may add.
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

    /// What a stored credential says, in the terms a config can say it. `None`
    /// for a password or an inline key, which a config never describes.
    fn of_stored(credential: &Credential) -> Option<Self> {
        let key_path = match &credential.kind {
            CredentialKind::SshKey {
                private_key_path: Some(path),
                ..
            } => Some(path.clone()),
            CredentialKind::Agent {} => None,
            _ => return None,
        };
        Some(Self {
            username: credential.username.clone(),
            key_path,
        })
    }
}

/// The credentials a plan can share and the names it cannot take, indexed
/// because a config can hold thousands of hosts with one key's file name.
#[derive(Default)]
struct CredentialBook {
    /// What each named credential says, to its id and name. Private ones
    /// belong to their connection and are never shared.
    shareable: HashMap<CredentialSpec, (String, String)>,
    taken: HashSet<String>,
    /// Per base name, the number to try next.
    next_number: HashMap<String, usize>,
}

impl CredentialBook {
    fn of(credentials: &[Credential]) -> Self {
        let mut book = Self::default();
        for credential in credentials {
            book.taken.insert(credential.name.clone());
            if credential.is_private {
                continue;
            }
            if let Some(spec) = CredentialSpec::of_stored(credential) {
                book.shareable
                    .entry(spec)
                    .or_insert_with(|| (credential.id.clone(), credential.name.clone()));
            }
        }
        book
    }

    fn free_name(&self, base: &str) -> String {
        if !self.taken.contains(base) {
            return base.to_string();
        }
        let first = self.next_number.get(base).copied().unwrap_or(2);
        (first..)
            .map(|n| format!("{base} ({n})"))
            .find(|name| !self.taken.contains(name))
            .unwrap_or_else(|| base.to_string())
    }

    /// The name `spec` goes by, given what is in the book so far.
    fn name_for(&self, spec: &CredentialSpec) -> String {
        match self.shareable.get(spec) {
            Some((_, name)) => name.clone(),
            None => self.free_name(&spec.default_name()),
        }
    }

    /// The credential `spec` needs, unless a shareable one exists. Only a path
    /// and a username go in: there is nothing for the secrets file.
    fn draft(&self, spec: &CredentialSpec) -> Result<Credential, String> {
        let name = self.name_for(spec);
        validate_credential_fields(&name, &spec.username, false)?;
        Ok(Credential {
            id: Uuid::new_v4().to_string(),
            name,
            username: spec.username.clone(),
            kind: spec.kind(),
            is_private: false,
        })
    }

    /// Find the credential `spec` describes, or store it in `data` and enter
    /// it here, so it takes its name and the next host can share it.
    fn store(&mut self, data: &mut AppData, spec: &CredentialSpec) -> Result<String, String> {
        if let Some((id, _)) = self.shareable.get(spec) {
            return Ok(id.clone());
        }
        let credential = self.draft(spec)?;
        let base = spec.default_name();
        if credential.name != base {
            *self.next_number.entry(base).or_insert(2) += 1;
        }
        let id = credential.id.clone();
        self.taken.insert(credential.name.clone());
        self.shareable
            .insert(spec.clone(), (id.clone(), credential.name.clone()));
        data.credentials.push(credential);
        Ok(id)
    }
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
        (Some(user), _) => {
            if user.contains('%') {
                return Err(Refusal::unsupported(format!(
                    "The user '{user}' in ProxyJump uses a token, which SSIX cannot expand"
                )));
            }
            user.to_string()
        }
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
    server: &ServerPlan,
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
            // With the real values: connecting expands it the same way, and
            // refuses a host or user that is not safe in a command line.
            crate::proxy::expand(
                command,
                &server.host,
                server.port,
                &server.credential.username,
            )
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
            json!(self.target_credential),
            json!(self.gateway_credential),
        )
    }

    /// The credentials it signs in with, first hop first, in the words the
    /// connection form uses.
    fn credentials_by_role(&self) -> Vec<(&CredentialSpec, &'static str)> {
        let mut roles = Vec::new();
        if let Some(spec) = &self.gateway_credential {
            let role = if self.kind.is_forward() {
                "SSH server credential"
            } else {
                "Jump host credential"
            };
            roles.push((spec, role));
        }
        if let Some(spec) = &self.target_credential {
            let role = if self.gateway_credential.is_some() {
                "Target credential"
            } else {
                "Credential"
            };
            roles.push((spec, role));
        }
        roles
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

/// Where a connection goes and who it signs in as, whatever it is called. Two
/// hosts for one server with different keys are two accounts, as in the classic
/// `github-work` and `github-personal`. A stored connection answers with its
/// credential's key path, so one the user moved to a password no longer matches;
/// `KnownConnections` still refuses its name, which keeps it from being overwritten.
fn signature(
    kind: &ConnectionKind,
    host: &str,
    port: u16,
    proxy_command: Option<&str>,
    target: Json,
    gateway: Json,
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
        "target": target,
        "gateway": gateway,
    })
}

fn connection_signature(connection: &Connection, credentials: &[Credential]) -> Json {
    let identity = |id: &str| {
        let Some(credential) = credentials.iter().find(|c| c.id == id) else {
            return Json::Null;
        };
        match CredentialSpec::of_stored(credential) {
            Some(spec) => json!(spec),
            None => json!({ "username": credential.username, "by_hand": true }),
        }
    };
    let gateway = serde_json::to_value(&connection.kind)
        .ok()
        .and_then(|kind| {
            kind.get("gateway_credential_id")
                .and_then(Json::as_str)
                .map(str::to_string)
        })
        .map_or(Json::Null, |id| identity(&id));
    // A forward only signs in to its SSH server; its `credential_id` is unused.
    let target = if connection.kind.is_forward() {
        Json::Null
    } else {
        connection
            .credential_id
            .as_deref()
            .map_or(Json::Null, identity)
    };
    signature(
        &connection.kind,
        &connection.host,
        connection.port,
        connection.proxy_command.as_deref(),
        target,
        gateway,
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
    plan: &mut Plan,
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
    let planned = server_plan(env, alias, &resolved, None, None).and_then(|server| {
        let route = route(env, config, alias, &resolved, &server)?;
        Ok((server, route))
    });
    let (server, route) = match planned {
        Ok(planned) => planned,
        Err(refusal) => return vec![Err(refusal.skip(alias, at))],
    };
    if let Some(first) = &resolved.forwards_left_out {
        plan.report_limit(
            format!("Forwards after the first {MAX_FORWARDS_PER_HOST} of a host were not read"),
            first,
        );
    }

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
    credentials: Vec<ImportCredentialPlan>,
    preselected: bool,
}

#[derive(Default)]
struct Plan {
    items: Vec<PlanItem>,
    skipped: Vec<ImportSkip>,
    notices: Vec<ImportNotice>,
    /// The name each new credential asks for, to tell the rows that would
    /// have to number theirs if an earlier row is ticked too.
    new_credentials: HashMap<String, CredentialSpec>,
    /// Limits reported so far: each one is reported once, however often it is hit.
    limits_reported: HashSet<String>,
    /// Skips past `MAX_SKIPS`, which are counted and not listed.
    skips_left_out: usize,
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

    /// Why a connection with this name and destination must not be offered.
    fn refusal(&self, name: &str, destination: &str) -> Option<Refusal> {
        let refuse = |category, reason: String| Some(Refusal { category, reason });
        if let Some((known, stored)) = self.by_name.get(name) {
            return match (*stored, known == destination) {
                (true, true) => refuse(
                    ImportSkipCategory::AlreadyImported,
                    "Already in SSIX".to_string(),
                ),
                (true, false) => refuse(
                    ImportSkipCategory::NameClash,
                    format!(
                        "A connection named '{name}' already exists with another destination or key. It stays as it is; rename it or the Host to import this one"
                    ),
                ),
                (false, _) => refuse(
                    ImportSkipCategory::Duplicate,
                    "An earlier entry in this config uses the same name".to_string(),
                ),
            };
        }
        match self.by_destination.get(destination) {
            Some((twin, true)) => refuse(
                ImportSkipCategory::AlreadyImported,
                format!("Already in SSIX as '{twin}'"),
            ),
            _ => None,
        }
    }

    /// The earlier row of this plan with the same destination, if any.
    fn twin(&self, destination: &str) -> Option<&str> {
        match self.by_destination.get(destination) {
            Some((twin, false)) => Some(twin),
            _ => None,
        }
    }
}

/// Run `planned` through the checks a real save runs, on its own: whether
/// another row is ticked must not decide whether this one can be. `scratch`
/// comes back as it was.
fn check_row(
    planned: &PlannedConnection,
    scratch: &mut AppData,
    book: &CredentialBook,
) -> Result<(), String> {
    fn stage(
        spec: &Option<CredentialSpec>,
        scratch: &mut AppData,
        book: &CredentialBook,
    ) -> Result<Option<String>, String> {
        let Some(spec) = spec else {
            return Ok(None);
        };
        if let Some((id, _)) = book.shareable.get(spec) {
            return Ok(Some(id.clone()));
        }
        let credential = book.draft(spec)?;
        let id = credential.id.clone();
        scratch.credentials.push(credential);
        Ok(Some(id))
    }

    let before = scratch.credentials.len();
    let checked = stage(&planned.gateway_credential, scratch, book).and_then(|gateway_id| {
        let target_id = stage(&planned.target_credential, scratch, book)?;
        let mut fields = planned.fields(target_id, gateway_id);
        check_connection(scratch, &mut fields, None)
    });
    scratch.credentials.truncate(before);
    checked
}

impl Plan {
    fn skip(&mut self, skip: ImportSkip) {
        if self.skipped.len() < MAX_SKIPS {
            self.skipped.push(skip);
        } else {
            self.skips_left_out += 1;
        }
    }

    fn report_limit(&mut self, message: String, at: &Source) {
        if self.limits_reported.insert(message.clone()) {
            self.notices.push(ImportNotice {
                message,
                source: at.to_string(),
            });
        }
    }

    fn report_row_limit(&mut self, at: &Source) {
        self.report_limit(
            format!("Only the first {MAX_ROWS} connections are offered: the rest of the config was not planned"),
            at,
        );
    }

    /// Offer `planned` as a row, or say why not. `scratch` is the stored data,
    /// and `book` its credentials: a row's name and validity are worked out
    /// against those alone, because the other rows may end up unticked.
    fn admit(
        &mut self,
        mut planned: PlannedConnection,
        scratch: &mut AppData,
        book: &CredentialBook,
        known: &mut KnownConnections,
    ) {
        let destination = planned.signature().to_string();
        if let Some(refusal) = known.refusal(&planned.name, &destination) {
            self.skip(refusal.skip(&planned.name, &planned.source));
            return;
        }
        if self.items.len() >= MAX_ROWS {
            self.report_row_limit(&planned.source);
            return;
        }
        if let Err(reason) = check_row(&planned, scratch, book) {
            self.skip(Refusal::invalid(reason).skip(&planned.name, &planned.source));
            return;
        }

        let mut credentials = Vec::new();
        let mut notes = Vec::new();
        for (spec, role) in planned.credentials_by_role() {
            let name = book.name_for(spec);
            let exists = book.shareable.contains_key(spec);
            if !exists {
                let first = self
                    .new_credentials
                    .entry(name.clone())
                    .or_insert_with(|| spec.clone());
                if first != spec {
                    notes.push(format!(
                        "If a host above with another key named {name} is ticked too, this credential's name gets a number"
                    ));
                }
            }
            credentials.push(ImportCredentialPlan {
                role: role.to_string(),
                name,
                username: spec.username.clone(),
                private_key_path: spec.key_path.clone(),
                exists,
            });
        }
        planned.notes.extend(notes);

        let twin = known.twin(&destination).map(str::to_string);
        if let Some(twin) = &twin {
            planned.notes.push(format!(
                "Same destination as '{twin}', so it starts unticked. Tick it to have this name instead, or as well"
            ));
        }
        known.add(&planned.name, destination, false);
        self.items.push(PlanItem {
            key: planned.key(),
            planned,
            credentials,
            preselected: twin.is_none(),
        });
    }

    fn into_preview(self, config: &ParsedConfig, path: String) -> ImportPreview {
        let skips_left_out = (self.skips_left_out > 0).then(|| ImportNotice {
            message: format!(
                "{} more skipped entries are not listed: only the first {MAX_SKIPS} are",
                self.skips_left_out
            ),
            source: path.clone(),
        });
        let notices = config
            .notices
            .iter()
            .map(|notice| ImportNotice {
                message: notice.message.clone(),
                source: notice.source.to_string(),
            })
            .chain(self.notices)
            .chain(skips_left_out)
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
                    preselected: item.preselected,
                })
                .collect(),
            skipped: self.skipped,
            notices,
        }
    }
}

/// Decide what importing `config` over `data` would do. Pure: nothing here
/// depends on which rows the user will tick, and every check runs on a copy.
fn build_plan(config: &ParsedConfig, data: &AppData, env: &ImportEnv) -> Plan {
    let mut scratch = data.clone();
    let book = CredentialBook::of(&data.credentials);
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
                plan.skip(ImportSkip {
                    name: pattern,
                    category: ImportSkipCategory::Pattern,
                    reason: reason.to_string(),
                    source: at.to_string(),
                });
            }
            HostEntry::Alias { name, at } => {
                if hosts >= MAX_HOSTS || config.resolve_steps() >= MAX_RESOLVE_STEPS {
                    plan.report_limit(format!("Hosts after the first {hosts} were not read"), &at);
                    continue;
                }
                if plan.items.len() >= MAX_ROWS {
                    plan.report_row_limit(&at);
                    continue;
                }
                hosts += 1;
                for outcome in plan_alias(config, env, &name, &at, &mut plan) {
                    match outcome {
                        Ok(planned) => plan.admit(planned, &mut scratch, &book, &mut known),
                        Err(skip) => plan.skip(skip),
                    }
                }
            }
        }
    }
    if config.unapplied {
        for item in &mut plan.items {
            item.preselected = false;
            item.planned.notes.push(UNAPPLIED_NOTE.to_string());
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
        // Names come from what is really stored, in the order of the rows
        // ticked: a row left unticked reserves nothing.
        let mut book = CredentialBook::of(&data.credentials);
        let mut result = ImportResult::default();
        for item in plan
            .items
            .iter()
            .filter(|item| selected.contains(item.key.as_str()))
        {
            let credentials_before = data.credentials.len();
            let mut store = |spec: &Option<CredentialSpec>| {
                spec.as_ref().map(|s| book.store(data, s)).transpose()
            };
            let gateway_id = store(&item.planned.gateway_credential)?;
            let target_id = store(&item.planned.target_credential)?;
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
    fn a_token_in_the_proxy_jump_user_is_refused_as_it_is_in_user() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host a\n  User app\n  ProxyJump %r@bastion\nHost b\n  User app\n  ProxyJump ssh://%u@bastion:2200\nHost bastion\n  User ops\n",
            );
            assert_eq!(names(&preview), ["bastion"]);
            for (name, token) in [("a", "%r"), ("b", "%u")] {
                let refused = skip(&preview, name);
                assert_eq!(refused.category, ImportSkipCategory::Unsupported);
                assert!(
                    refused.reason.starts_with("Jump host bastion:"),
                    "{}",
                    refused.reason
                );
                assert!(refused.reason.contains(token), "{}", refused.reason);
                assert!(refused.reason.contains("token"), "{}", refused.reason);
            }
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
    fn a_proxy_command_that_would_refuse_this_host_is_skipped() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host odd-user\n  HostName s\n  User me+x\n  ProxyCommand nc %r@%h %p\nHost odd+host\n  User u\n  ProxyCommand nc %h %p\nHost odd-unused\n  HostName s\n  User me+x\n  ProxyCommand nc %h %p\nHost odd+literal\n  User u\n  ProxyCommand nc relay 22\n",
            );
            let user = skip(&preview, "odd-user");
            assert_eq!(user.category, ImportSkipCategory::Unsupported);
            assert!(user.reason.contains("me+x"), "{}", user.reason);
            assert!(user.reason.contains("~/.ssh/config:4"), "{}", user.reason);
            assert!(skip(&preview, "odd+host").reason.contains("odd+host"));
            // Only the tokens it uses have to be safe, as when connecting.
            assert_eq!(names(&preview), ["odd-unused", "odd+literal"]);
        });
    }

    #[test]
    fn what_a_preview_offers_with_a_proxy_command_expands_when_connecting() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host web\n  HostName 10.0.0.1\n  Port 2200\n  User deploy\n  ProxyCommand nc %r@%h %p\n  LocalForward 8080 db:1\n",
            );
            f.apply_all(&preview);
            let direct = stored("web");
            assert_eq!(
                crate::proxy::expand(
                    direct.proxy_command.as_deref().unwrap(),
                    &direct.host,
                    direct.port,
                    "deploy",
                )
                .unwrap(),
                "nc deploy@10.0.0.1 2200"
            );
            assert!(stored("web (-L 8080)").proxy_command.is_some());
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

    /// Every row starts unticked and carries the note.
    fn assert_all_held_back(preview: &ImportPreview) {
        assert!(!preview.items.is_empty());
        for row in &preview.items {
            assert!(!row.preselected, "{row:#?}");
            assert!(row.notes.iter().any(|n| n == UNAPPLIED_NOTE), "{row:#?}");
        }
    }

    /// Nothing in the config was left out: rows start ticked, without the note.
    fn assert_none_held_back(preview: &ImportPreview) {
        assert!(!preview.items.is_empty());
        for row in &preview.items {
            assert!(row.preselected, "{row:#?}");
            assert!(!row.notes.iter().any(|n| n == UNAPPLIED_NOTE), "{row:#?}");
        }
    }

    #[test]
    fn a_dropped_match_holds_back_every_row() {
        in_data_dir(|f| {
            // ssh would reach web through the bastion; the import cannot know.
            let text = "Host web\n  User u\n  LocalForward 1 d:1\nHost db\n  User u\nMatch host web\n  ProxyJump bastion\n";
            let preview = f.preview(text);
            assert_eq!(names(&preview), ["web", "web (-L 1)", "db"]);
            assert_all_held_back(&preview);
            assert_eq!(item(&preview, "web").kind, "direct");
            assert_eq!(notices_saying(&preview, "Match block skipped").len(), 1);

            // It can still be chosen, row by row.
            let result = f.apply(vec![item(&preview, "db").key.clone()]).unwrap();
            assert_eq!(result.connections, ["db"]);
        });
    }

    #[test]
    fn an_include_that_was_not_applied_holds_back_every_row() {
        in_data_dir(|f| {
            f.home.write(".ssh/loop", "Include loop\n");
            f.home.write(".ssh/big", &"#".repeat(2 * 1024 * 1024));
            for include in [
                "Include [ab]",
                "Include ~bob/config",
                "Include \"unbalanced",
                "Include ~/.ssh",
                "Include loop",
                "Include big",
            ] {
                let preview = f.preview(&format!("{include}\nHost web\n  User u\n"));
                assert_eq!(names(&preview), ["web"], "{include}");
                assert_all_held_back(&preview);
            }
        });
    }

    #[test]
    fn an_unreadable_host_line_holds_back_every_row() {
        in_data_dir(|f| {
            let preview = f.preview("Host \"web\n  ProxyJump bastion\nHost db\n  User u\n");
            assert_eq!(names(&preview), ["db"]);
            assert_all_held_back(&preview);
        });
    }

    #[test]
    fn an_include_ssh_would_ignore_too_holds_back_nothing() {
        in_data_dir(|f| {
            let preview = f
                .preview("Include /nonexistent/file\nInclude nothing-here/*\nHost web\n  User u\n");
            assert_eq!(preview.notices.len(), 2, "{:#?}", preview.notices);
            assert_none_held_back(&preview);
        });
    }

    #[test]
    fn an_unreadable_option_stays_with_the_host_it_applies_to() {
        in_data_dir(|f| {
            let preview = f.preview("Host bad\n  Port \"1\nHost good\n  User u\n");
            assert_eq!(names(&preview), ["good"]);
            assert_eq!(skip(&preview, "bad").category, ImportSkipCategory::Invalid);
            assert_none_held_back(&preview);
        });
    }

    #[test]
    fn a_config_with_nothing_left_out_starts_ticked() {
        in_data_dir(|f| {
            assert_none_held_back(&f.preview(BASIC));
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

    const ACCOUNTS: &str = "Host github-work\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/id_work\nHost github-personal\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/id_personal\n";

    /// Point a stored connection at a new password credential.
    fn move_to_password(name: &str) {
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
            let connection = data.connections.iter_mut().find(|c| c.name == name);
            connection.unwrap().credential_id = Some(id);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn hosts_with_different_keys_for_one_server_are_different_accounts() {
        in_data_dir(|f| {
            let preview = f.preview(ACCOUNTS);
            assert_eq!(names(&preview), ["github-work", "github-personal"]);
            assert!(preview.skipped.is_empty(), "{:#?}", preview.skipped);

            let result = f.apply_all(&preview);
            assert_eq!(result.connections, ["github-work", "github-personal"]);
            assert_eq!(result.credentials, ["git@id_work", "git@id_personal"]);
            let key_of = |name: &str| {
                let id = stored(name).credential_id.unwrap();
                CredentialSpec::of_stored(&credential_of(&id))
                    .unwrap()
                    .key_path
            };
            assert_eq!(key_of("github-work"), Some(f.key_path(".ssh/id_work")));
            assert_eq!(
                key_of("github-personal"),
                Some(f.key_path(".ssh/id_personal"))
            );

            // Each one still recognises itself, so importing again adds nothing.
            let again = f.preview(ACCOUNTS);
            assert!(again.items.is_empty(), "{:#?}", again.items);
            for name in ["github-work", "github-personal"] {
                assert_eq!(
                    skip(&again, name).category,
                    ImportSkipCategory::AlreadyImported
                );
            }
        });
    }

    #[test]
    fn a_key_and_the_agent_are_different_accounts_too() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host with-key\n  HostName s\n  User u\n  IdentityFile ~/.ssh/id\nHost with-agent\n  HostName s\n  User u\n",
            );
            assert_eq!(names(&preview), ["with-key", "with-agent"]);
        });
    }

    #[test]
    fn forwards_and_jump_hosts_compare_their_keys_as_well() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host a\n  HostName s\n  User u\n  IdentityFile ~/.ssh/one\n  LocalForward 1 d:1\nHost b\n  HostName s\n  User u\n  IdentityFile ~/.ssh/two\n  LocalForward 1 d:1\nHost c\n  HostName t\n  User u\n  IdentityFile ~/.ssh/t\n  ProxyJump a\nHost d\n  HostName t\n  User u\n  IdentityFile ~/.ssh/t\n  ProxyJump b\n",
            );
            assert_eq!(
                names(&preview),
                ["a", "a (-L 1)", "b", "b (-L 1)", "c", "d"]
            );
        });
    }

    #[test]
    fn a_stored_connection_is_compared_by_its_key_path() {
        in_data_dir(|f| {
            f.import(
                "Host mine\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/id_work\n",
            );

            let preview = f.preview(ACCOUNTS);
            let work = skip(&preview, "github-work");
            assert_eq!(work.category, ImportSkipCategory::AlreadyImported);
            assert!(work.reason.contains("'mine'"), "{}", work.reason);
            // The same server under the other key is an account SSIX lacks.
            assert_eq!(names(&preview), ["github-personal"]);
        });
    }

    #[test]
    fn a_connection_moved_to_a_password_is_never_overwritten() {
        in_data_dir(|f| {
            f.import(BASIC);
            move_to_password("web");
            let before = stored("web");

            let preview = f.preview(BASIC);
            assert!(preview.items.is_empty());
            assert_eq!(
                skip(&preview, "web").category,
                ImportSkipCategory::NameClash
            );
            assert_eq!(stored("web").credential_id, before.credential_id);
        });
    }

    #[test]
    fn a_renamed_connection_moved_to_a_password_no_longer_matches() {
        in_data_dir(|f| {
            f.import(BASIC);
            with_data_mut(|data| {
                data.connections[0].name = "my web".to_string();
                Ok(())
            })
            .unwrap();
            move_to_password("my web");
            assert_eq!(names(&f.preview(BASIC)), ["web"]);
        });
    }

    const TWINS: &str =
        "Host web web.prod\n  HostName 10.0.0.1\n  User deploy\n  IdentityFile ~/.ssh/id\n";

    fn preselected(preview: &ImportPreview) -> Vec<&str> {
        let ticked = preview.items.iter().filter(|i| i.preselected);
        ticked.map(|i| i.name.as_str()).collect()
    }

    #[test]
    fn of_two_aliases_with_one_destination_the_later_starts_unticked() {
        in_data_dir(|f| {
            let preview = f.preview(TWINS);
            assert_eq!(names(&preview), ["web", "web.prod"]);
            assert_eq!(preselected(&preview), ["web"]);
            let twin = item(&preview, "web.prod");
            assert!(twin.notes.iter().any(|n| n.contains("'web'")), "{twin:#?}");
            assert!(preview.skipped.is_empty(), "{:#?}", preview.skipped);
        });
    }

    #[test]
    fn unticking_an_alias_lets_its_twin_be_imported_instead() {
        in_data_dir(|f| {
            let preview = f.preview(TWINS);
            let result = f
                .apply(vec![item(&preview, "web.prod").key.clone()])
                .unwrap();
            assert_eq!(result.connections, ["web.prod"]);
            assert_eq!(result.credentials, ["deploy@id"]);

            // From now on the first alias is the one already imported.
            let again = f.preview(TWINS);
            assert!(again.items.is_empty(), "{:#?}", again.items);
            let web = skip(&again, "web");
            assert_eq!(web.category, ImportSkipCategory::AlreadyImported);
            assert!(web.reason.contains("'web.prod'"), "{}", web.reason);
        });
    }

    #[test]
    fn ticking_both_aliases_creates_both_and_they_share_a_credential() {
        in_data_dir(|f| {
            let result = f.import(TWINS);
            assert_eq!(result.connections, ["web", "web.prod"]);
            assert_eq!(result.credentials, ["deploy@id"]);
            let again = f.preview(TWINS);
            assert!(again.items.is_empty(), "{:#?}", again.items);
        });
    }

    #[test]
    fn a_third_alias_names_the_first_and_forwards_follow_their_host() {
        in_data_dir(|f| {
            let preview = f.preview(
                "Host a b c\n  HostName s\n  User u\n  IdentityFile ~/.ssh/id\n  LocalForward 1 d:1\n",
            );
            assert_eq!(preselected(&preview), ["a", "a (-L 1)"]);
            let third = item(&preview, "c");
            assert!(third.notes.iter().any(|n| n.contains("'a'")), "{third:#?}");
            assert!(item(&preview, "c (-L 1)")
                .notes
                .iter()
                .any(|n| n.contains("'a (-L 1)'")));
        });
    }

    const SAME_FILE_NAME: &str =
        "Host a\n  User u\n  IdentityFile /a/id\nHost b\n  User u\n  IdentityFile /b/id\nHost c\n  User u\n  IdentityFile /c/id\n";

    fn credential_name_of(connection: &str) -> String {
        credential_of(stored(connection).credential_id.as_deref().unwrap()).name
    }

    #[test]
    fn a_credential_name_is_only_taken_by_the_rows_really_ticked() {
        in_data_dir(|f| {
            let preview = f.preview(SAME_FILE_NAME);
            let result = f.apply(vec![item(&preview, "b").key.clone()]).unwrap();
            assert_eq!(result.credentials, ["u@id"]);
            assert_eq!(credential_name_of("b"), "u@id");
        });
    }

    #[test]
    fn credentials_with_one_name_are_numbered_in_row_order_when_ticked() {
        in_data_dir(|f| {
            let preview = f.preview(SAME_FILE_NAME);
            let result = f.apply_all(&preview);
            assert_eq!(result.credentials, ["u@id", "u@id (2)", "u@id (3)"]);
            assert_eq!(credential_name_of("c"), "u@id (3)");
        });
    }

    #[test]
    fn the_preview_never_promises_a_number_a_tick_could_change() {
        in_data_dir(|f| {
            let preview = f.preview(SAME_FILE_NAME);
            for name in ["a", "b", "c"] {
                assert_eq!(item(&preview, name).credentials[0].name, "u@id");
            }
            let says_so = |name: &str| {
                item(&preview, name)
                    .notes
                    .iter()
                    .any(|n| n.contains("gets a number"))
            };
            assert!(!says_so("a"));
            assert!(says_so("b"));
            assert!(says_so("c"));
        });
    }

    #[test]
    fn hosts_sharing_a_new_credential_need_no_number() {
        in_data_dir(|f| {
            let preview = f.preview("Host a b\n  User u\n  IdentityFile /a/id\n");
            assert!(item(&preview, "b").notes.is_empty(), "{preview:#?}");
        });
    }

    #[test]
    fn a_number_around_a_stored_name_is_skipped_over() {
        in_data_dir(|f| {
            with_data_mut(|data| {
                for name in ["u@id", "u@id (2)"] {
                    data.credentials.push(Credential {
                        id: Uuid::new_v4().to_string(),
                        name: name.to_string(),
                        username: "someone-else".to_string(),
                        kind: CredentialKind::Agent {},
                        is_private: false,
                    });
                }
                Ok(())
            })
            .unwrap();
            let preview = f.preview(SAME_FILE_NAME);
            assert_eq!(item(&preview, "a").credentials[0].name, "u@id (3)");
            let result = f.apply_all(&preview);
            assert_eq!(result.credentials, ["u@id (3)", "u@id (4)", "u@id (5)"]);
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
                let id = Uuid::new_v4().to_string();
                data.credentials.push(Credential {
                    id: id.clone(),
                    name: "my deploy key".to_string(),
                    username: "deploy".to_string(),
                    kind: CredentialSpec {
                        username: "deploy".to_string(),
                        key_path: Some(f.key_path(".ssh/id_web")),
                    }
                    .kind(),
                    is_private: false,
                });
                Ok(id)
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

    /// Far more than any of these takes, and far less than the fan-out they
    /// guard against, which would plan about 100M rows.
    const QUICKLY: std::time::Duration = std::time::Duration::from_secs(60);

    fn notices_saying<'a>(preview: &'a ImportPreview, phrase: &str) -> Vec<&'a ImportNotice> {
        let saying = preview
            .notices
            .iter()
            .filter(|n| n.message.contains(phrase));
        saying.collect()
    }

    #[test]
    fn a_default_block_of_forwards_cannot_fan_out_over_every_host() {
        in_data_dir(|f| {
            let mut text: String = (0..MAX_HOSTS).map(|i| format!("Host h{i}\n")).collect();
            text.push_str("Host *\n  User u\n");
            for i in 0..38_000 {
                text.push_str(&format!("  LocalForward {} d:1\n", 1 + i % 60_000));
            }
            assert!(text.len() < 1024 * 1024, "{}", text.len());
            let started = std::time::Instant::now();

            let preview = f.preview(&text);
            assert_eq!(preview.items.len(), MAX_ROWS);
            let first_host = preview
                .items
                .iter()
                .filter(|i| i.name.starts_with("h0 (-L "))
                .count();
            assert_eq!(first_host, MAX_FORWARDS_PER_HOST);
            assert_eq!(
                notices_saying(&preview, "Forwards after the first").len(),
                1
            );
            assert_eq!(notices_saying(&preview, "connections are offered").len(), 1);

            // Apply plans again and stores every row, all under the data lock.
            let result = f.apply_all(&preview);
            assert_eq!(result.connections.len(), MAX_ROWS);
            assert!(started.elapsed() < QUICKLY, "{:?}", started.elapsed());
        });
    }

    #[test]
    fn a_file_of_patterns_lists_a_limited_number_of_skips() {
        in_data_dir(|f| {
            let mut text = String::from("Host real\n  User u\n");
            for i in 0..70_000 {
                text.push_str(&format!("Host *x{i}\n"));
            }
            assert!(text.len() < 1024 * 1024, "{}", text.len());
            let started = std::time::Instant::now();

            let preview = f.preview(&text);
            assert_eq!(names(&preview), ["real"]);
            assert_eq!(preview.skipped.len(), MAX_SKIPS);
            let left_out = notices_saying(&preview, "more skipped entries");
            assert_eq!(left_out.len(), 1);
            assert!(
                left_out[0]
                    .message
                    .starts_with(&(70_000 - MAX_SKIPS).to_string()),
                "{}",
                left_out[0].message
            );
            assert!(started.elapsed() < QUICKLY, "{:?}", started.elapsed());
        });
    }

    #[test]
    fn a_file_of_match_lines_lists_a_limited_number_of_notices() {
        in_data_dir(|f| {
            let text = format!("Host real\n  User u\n{}", "Match all\n".repeat(100_000));
            assert!(text.len() < 1024 * 1024, "{}", text.len());
            let started = std::time::Instant::now();

            let preview = f.preview(&text);
            assert_eq!(names(&preview), ["real"]);
            assert_eq!(notices_saying(&preview, "were passed over too").len(), 1);
            assert!(preview.notices.len() < 300, "{}", preview.notices.len());
            assert_all_held_back(&preview);
            assert!(started.elapsed() < QUICKLY, "{:?}", started.elapsed());
        });
    }

    #[test]
    fn a_file_slow_to_match_stops_at_its_budget_and_says_where() {
        in_data_dir(|f| {
            // Each pattern backs up over the whole name, on every host.
            let name = "a".repeat(120);
            let mut text: String = (0..MAX_HOSTS)
                .map(|i| format!("Host {name}{i}\n  User u\n"))
                .collect();
            let pattern = format!("*{}b", "a".repeat(60));
            while text.len() < 1024 * 1024 - 100 {
                text.push_str(&format!("Host {pattern}\n"));
            }
            let started = std::time::Instant::now();

            let preview = f.preview(&text);
            assert!(preview.items.len() < MAX_HOSTS, "{}", preview.items.len());
            let notice = notices_saying(&preview, "were not read");
            assert_eq!(notice.len(), 1);
            assert!(
                notice[0].message.contains(&preview.items.len().to_string()),
                "{}",
                notice[0].message
            );
            assert!(started.elapsed() < QUICKLY, "{:?}", started.elapsed());

            // Planning again stops at the same host, so its keys still match.
            let result = f.apply_all(&preview);
            assert_eq!(result.connections.len(), preview.items.len());
        });
    }

    #[test]
    fn thousands_of_keys_with_one_file_name_are_numbered_without_searching() {
        in_data_dir(|f| {
            let text: String = (0..MAX_HOSTS)
                .map(|i| format!("Host h{i}\n  User u\n  IdentityFile /k{i}/id\n"))
                .collect();
            let started = std::time::Instant::now();
            let result = f.import(&text);
            assert_eq!(result.credentials.len(), MAX_HOSTS);
            assert_eq!(result.credentials[0], "u@id");
            assert_eq!(
                result.credentials[MAX_HOSTS - 1],
                format!("u@id ({MAX_HOSTS})")
            );
            let unique: HashSet<&String> = result.credentials.iter().collect();
            assert_eq!(unique.len(), MAX_HOSTS);
            assert!(started.elapsed() < QUICKLY, "{:?}", started.elapsed());
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
