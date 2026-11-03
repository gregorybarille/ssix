//! Reader for OpenSSH client configuration (`ssh_config(5)`), used by the
//! import in `commands::import_config`. It follows `readconf.c` wherever the
//! import depends on the behaviour:
//!
//! - Options before the first `Host` line apply to every host.
//! - A `Host` line starts a block that applies when any pattern matches and
//!   no negated pattern does; `*` and `?` are the only wildcards.
//! - The first value of an option wins, read top to bottom, so `Host *`
//!   defaults usually come last. `IdentityFile` and the three forward
//!   directives collect every value instead.
//! - `ProxyJump` and `ProxyCommand` share one slot: whichever comes first
//!   wins, and `none` counts as a value, except that a `ProxyCommand` still
//!   replaces `ProxyJump none`.
//! - `Include` reads relative paths from `~/.ssh`, expands `~` and globs, and
//!   a `Host` or `Match` inside an included file does not leak out of it. An
//!   `Include` inside a block that does not apply reads nothing that applies.
//!
//! The file is untrusted text and nothing here panics on it. A line that
//! cannot be read becomes a [`Notice`], and when it holds an option the host
//! that option applies to gets the failure as its [`Value::args`], so the
//! import reports a skip rather than quietly connecting somewhere else.
//!
//! `Match` is deliberately not evaluated: its conditions depend on the
//! machine and the connection. Its block is dropped and reported.
//!
//! What is dropped this way can change any host, and nothing here can tell
//! which: a `Match` may be the line that sends a host through its bastion. So
//! it sets [`ParsedConfig::unapplied`], which the import has to act on. An
//! `Include` that matches no file does not: `ssh` reads nothing from it either.

use std::borrow::Cow;
use std::cell::Cell;
use std::cmp::Ordering;
use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Longest line read; anything longer is reported and ignored.
const MAX_LINE_BYTES: usize = 4096;
/// Everything one import reads, across all included files.
const MAX_TOTAL_BYTES: u64 = 1024 * 1024;
/// OpenSSH's own limit (`READCONF_MAX_DEPTH`).
const MAX_INCLUDE_DEPTH: usize = 16;
const MAX_FILES: usize = 64;
/// Forwards one host keeps. A `Host *` block with tens of thousands of them
/// would otherwise be copied for every host.
pub const MAX_FORWARDS_PER_HOST: usize = 64;
/// `IdentityFile` values one host keeps, for the same reason. Only the first
/// is ever used.
const MAX_IDENTITY_FILES: usize = 64;
/// Notices one read keeps. The one after these says the list stops there.
const MAX_NOTICES: usize = 200;
/// What setting up one wildcard comparison costs in `resolve_steps`, on top
/// of its loop: it allocates, which a plain comparison does not.
const WILDCARD_SETUP_STEPS: usize = 16;

/// A line of a config file, shown as `~/.ssh/config:12`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub file: String,
    pub line: usize,
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.file, self.line)
    }
}

/// Something the reader skipped that the user should hear about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub source: Source,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Keyword {
    HostName,
    Port,
    User,
    IdentityFile,
    ProxyJump,
    ProxyCommand,
    LocalForward,
    RemoteForward,
    DynamicForward,
}

impl Keyword {
    fn from_lowercase(word: &str) -> Option<Self> {
        Some(match word {
            "hostname" => Self::HostName,
            "port" => Self::Port,
            "user" => Self::User,
            "identityfile" => Self::IdentityFile,
            "proxyjump" => Self::ProxyJump,
            "proxycommand" => Self::ProxyCommand,
            "localforward" => Self::LocalForward,
            "remoteforward" => Self::RemoteForward,
            "dynamicforward" => Self::DynamicForward,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::HostName => "HostName",
            Self::Port => "Port",
            Self::User => "User",
            Self::IdentityFile => "IdentityFile",
            Self::ProxyJump => "ProxyJump",
            Self::ProxyCommand => "ProxyCommand",
            Self::LocalForward => "LocalForward",
            Self::RemoteForward => "RemoteForward",
            Self::DynamicForward => "DynamicForward",
        }
    }
}

/// One option as written.
#[derive(Debug, Clone)]
pub struct Value {
    /// The directive's name in its usual spelling, for messages.
    pub keyword: &'static str,
    /// The words after the keyword, with quotes and escapes removed, or why
    /// the line could not be read. The failure is a value too: under the
    /// first-value-wins rule a host must not fall through to a later line.
    pub args: Result<Vec<String>, String>,
    /// The text after the keyword as written, which is what `ProxyCommand`
    /// and `ProxyJump` keep.
    pub raw: String,
    pub at: Source,
}

impl Value {
    /// The option's one word, for the options that take one.
    pub fn single(&self) -> Result<&str, String> {
        match &self.args {
            Err(why) => Err(why.clone()),
            Ok(args) => match args.as_slice() {
                [only] => Ok(only),
                _ => Err(format!(
                    "{} on {} has more than one value",
                    self.keyword, self.at
                )),
            },
        }
    }
}

#[derive(Debug, Clone)]
struct Pattern {
    text: String,
    negated: bool,
}

impl Pattern {
    fn is_single_host(&self) -> bool {
        !self.negated && !self.text.contains(['*', '?'])
    }

    fn display(&self) -> String {
        if self.negated {
            format!("!{}", self.text)
        } else {
            self.text.clone()
        }
    }
}

#[derive(Debug)]
enum Statement {
    Host(Vec<Pattern>, Source),
    /// Ends the current block and starts one that never applies: a `Match`,
    /// or a `Host` line that could not be read. Options after it must not
    /// be taken for the block before it.
    Opaque,
    Directive(Keyword, Value),
    /// One included file. It starts in the including block's state, and
    /// that state comes back once it ends.
    Included(Vec<Statement>),
}

/// How a host reaches its first hop.
#[derive(Debug, Clone)]
pub enum Proxy {
    Jump(Value),
    Command(Value),
}

/// The options that apply to one host, after every first-value-wins rule.
#[derive(Debug, Default, Clone)]
pub struct ResolvedHost {
    pub host_name: Option<Value>,
    pub port: Option<Value>,
    pub user: Option<Value>,
    pub identity_files: Vec<Value>,
    pub proxy: Option<Proxy>,
    pub local_forwards: Vec<Value>,
    pub remote_forwards: Vec<Value>,
    pub dynamic_forwards: Vec<Value>,
    /// Whether a `Host` line naming this host literally applied. False when
    /// its only mention is negated or inside an `Include` whose enclosing
    /// block does not match it, where OpenSSH would ignore it too.
    pub named: bool,
    /// The first forward past `MAX_FORWARDS_PER_HOST`, if any.
    pub forwards_left_out: Option<Source>,
}

impl ResolvedHost {
    fn apply(&mut self, keyword: Keyword, value: &Value) {
        fn first(slot: &mut Option<Value>, value: &Value) {
            if slot.is_none() {
                *slot = Some(value.clone());
            }
        }
        match keyword {
            Keyword::HostName => first(&mut self.host_name, value),
            Keyword::Port => first(&mut self.port, value),
            Keyword::User => first(&mut self.user, value),
            Keyword::IdentityFile => {
                if self.identity_files.len() < MAX_IDENTITY_FILES {
                    self.identity_files.push(value.clone());
                }
            }
            Keyword::LocalForward | Keyword::RemoteForward | Keyword::DynamicForward => {
                self.add_forward(keyword, value);
            }
            Keyword::ProxyJump => {
                if self.proxy.is_none() {
                    self.proxy = Some(Proxy::Jump(value.clone()));
                }
            }
            Keyword::ProxyCommand => {
                // Raw on purpose: to `ssh`, `none # why` is a host called none.
                let free = match &self.proxy {
                    None => true,
                    Some(Proxy::Jump(jump)) => jump.raw.eq_ignore_ascii_case("none"),
                    Some(Proxy::Command(_)) => false,
                };
                if free {
                    self.proxy = Some(Proxy::Command(value.clone()));
                }
            }
        }
    }
}

impl ResolvedHost {
    fn add_forward(&mut self, keyword: Keyword, value: &Value) {
        let held =
            self.local_forwards.len() + self.remote_forwards.len() + self.dynamic_forwards.len();
        if held >= MAX_FORWARDS_PER_HOST {
            self.forwards_left_out
                .get_or_insert_with(|| value.at.clone());
            return;
        }
        let slot = match keyword {
            Keyword::LocalForward => &mut self.local_forwards,
            Keyword::RemoteForward => &mut self.remote_forwards,
            _ => &mut self.dynamic_forwards,
        };
        slot.push(value.clone());
    }
}

/// A name from a `Host` line, in file order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostEntry {
    /// A literal host, which can become a connection.
    Alias { name: String, at: Source },
    /// A wildcard or negated pattern, which only supplies options.
    Pattern { pattern: String, at: Source },
}

/// A config file and everything it includes.
#[derive(Debug)]
pub struct ParsedConfig {
    statements: Vec<Statement>,
    /// Lines and files that were skipped, in reading order.
    pub notices: Vec<Notice>,
    /// Every file read, for the preview to name.
    pub files: Vec<String>,
    /// Whether a `Match`, a `Host` line or an `Include` was left out, so that
    /// what `resolve` answers may not be what `ssh` would do for any host.
    pub unapplied: bool,
    /// What every `resolve` so far has cost, see `resolve_steps`.
    steps: Cell<usize>,
}

impl ParsedConfig {
    /// Read `path` and what it includes. Only a failure to read `path`
    /// itself is an error; anything below it becomes a notice.
    pub fn read(path: &Path, home: &Path) -> Result<Self, String> {
        let mut reader = Reader::new(home);
        let bytes = reader.read_bytes(path)?;
        reader.stack.push(canonical(path));
        let file = reader.display(path);
        let statements = reader.parse(&bytes, &file, 0);
        Ok(reader.finish(statements))
    }

    #[cfg(test)]
    pub fn parse_text(text: &str, home: &Path) -> Self {
        let mut reader = Reader::new(home);
        let statements = reader.parse(text.as_bytes(), "config", 0);
        reader.finish(statements)
    }

    /// The options OpenSSH would apply to `ssh <target>`.
    pub fn resolve(&self, target: &str) -> ResolvedHost {
        let mut out = ResolvedHost::default();
        let mut active = true;
        let mut steps = 0;
        walk(
            &self.statements,
            &mut active,
            false,
            target,
            &mut out,
            &mut steps,
        );
        self.steps.set(self.steps.get().saturating_add(steps));
        out
    }

    /// The work every `resolve` so far has done: statements visited and
    /// characters compared. Each host walks the whole file, so this is what a
    /// large or hostile file drives up, and it counts the same on every read
    /// of one file, so a preview and its apply stop at the same host.
    pub fn resolve_steps(&self) -> usize {
        self.steps.get()
    }

    /// Every distinct name on a `Host` line, in the order they first appear.
    pub fn host_entries(&self) -> Vec<HostEntry> {
        fn collect(
            statements: &[Statement],
            seen: &mut HashSet<String>,
            entries: &mut Vec<HostEntry>,
        ) {
            for statement in statements {
                match statement {
                    Statement::Host(patterns, at) => {
                        for pattern in patterns {
                            let name = pattern.display();
                            if !seen.insert(name.clone()) {
                                continue;
                            }
                            let at = at.clone();
                            entries.push(if pattern.is_single_host() {
                                HostEntry::Alias { name, at }
                            } else {
                                HostEntry::Pattern { pattern: name, at }
                            });
                        }
                    }
                    Statement::Included(children) => collect(children, seen, entries),
                    Statement::Opaque | Statement::Directive(..) => {}
                }
            }
        }
        let mut entries = Vec::new();
        collect(&self.statements, &mut HashSet::new(), &mut entries);
        entries
    }
}

/// Apply `statements` for `target`, as `read_config_file_depth` does.
/// `never_match` is OpenSSH's `SSHCONF_NEVERMATCH`: the file was included
/// from a block that does not apply, so nothing in it can.
fn walk(
    statements: &[Statement],
    active: &mut bool,
    never_match: bool,
    target: &str,
    out: &mut ResolvedHost,
    steps: &mut usize,
) {
    for statement in statements {
        *steps += 1;
        match statement {
            Statement::Host(patterns, _) => {
                *active = !never_match && block_applies(patterns, target, steps);
                if *active && patterns.iter().any(|p| !p.negated && p.text == target) {
                    out.named = true;
                }
            }
            Statement::Opaque => *active = false,
            Statement::Directive(keyword, value) => {
                if *active {
                    out.apply(*keyword, value);
                }
            }
            Statement::Included(children) => {
                let outer = *active;
                walk(children, active, never_match || !outer, target, out, steps);
                *active = outer;
            }
        }
    }
}

fn block_applies(patterns: &[Pattern], target: &str, steps: &mut usize) -> bool {
    let mut applies = false;
    for pattern in patterns {
        if wildcard_match_counted(&pattern.text, target, steps) {
            if pattern.negated {
                return false;
            }
            applies = true;
        }
    }
    applies
}

/// `*` and `?` matching, as OpenSSH's `match_pattern`. Remembers one star to
/// back up to, so a pattern with many stars cannot take exponential time.
fn wildcard_match(pattern: &str, text: &str) -> bool {
    wildcard_match_counted(pattern, text, &mut 0)
}

fn wildcard_match_counted(pattern: &str, text: &str, steps: &mut usize) -> bool {
    if !pattern.contains(['*', '?']) {
        *steps += 1;
        return pattern == text;
    }
    *steps += WILDCARD_SETUP_STEPS;
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0, 0);
    let mut star = None;
    let mut resume = 0;
    while t < text.len() {
        *steps += 1;
        if pattern.get(p) == Some(&'*') {
            star = Some(p);
            resume = t;
            p += 1;
        } else if pattern.get(p) == Some(&'?') || pattern.get(p) == Some(&text[t]) {
            p += 1;
            t += 1;
        } else if let Some(s) = star {
            p = s + 1;
            resume += 1;
            t = resume;
        } else {
            return false;
        }
    }
    pattern[p.min(pattern.len())..].iter().all(|c| *c == '*')
}

/// One line, cut into its keyword and what follows.
struct Line {
    keyword: String,
    /// The words after the keyword, or why they could not be read.
    args: Result<Vec<String>, String>,
    raw: String,
}

const BLANKS: [char; 2] = [' ', '\t'];

fn read_line(raw: &[u8], first_line: bool) -> Option<Line> {
    let too_long = raw.len() > MAX_LINE_BYTES;
    let decoded = String::from_utf8_lossy(&raw[..raw.len().min(MAX_LINE_BYTES)]);
    let invalid = matches!(decoded, Cow::Owned(_));
    let mut text: &str = &decoded;
    if first_line {
        text = text.strip_prefix('\u{feff}').unwrap_or(text);
    }
    let text = text
        .trim_start_matches([' ', '\t', '\r'])
        .trim_end_matches([' ', '\t', '\r', '\n', '\u{c}']);
    if text.is_empty() || text.starts_with('#') {
        return None;
    }

    // A keyword ends at a blank or `=`, and one `=` may separate it from
    // its value: `Port 22`, `Port=22` and `Port = 22` are the same line.
    let end = text.find([' ', '\t', '=']).unwrap_or(text.len());
    let keyword = text[..end].to_ascii_lowercase();
    let mut rest = text[end..].trim_start_matches(BLANKS);
    if let Some(after) = rest.strip_prefix('=') {
        rest = after.trim_start_matches(BLANKS);
    }

    let args = if too_long {
        Err(format!("it is longer than {MAX_LINE_BYTES} bytes"))
    } else if invalid {
        Err("it is not valid UTF-8".to_string())
    } else if text.chars().any(|c| c.is_control() && c != '\t') {
        Err("it contains control characters".to_string())
    } else {
        match split_args(rest) {
            None => Err("it has an unbalanced quote".to_string()),
            Some(args) if args.is_empty() => Err("it has no value".to_string()),
            Some(args) => Ok(args),
        }
    };
    Some(Line {
        keyword,
        args,
        raw: rest.to_string(),
    })
}

/// Split a value into words, as OpenSSH's `argv_split`: single or double
/// quotes group, `\` escapes a quote, a backslash or (outside quotes) a
/// space, and a `#` that starts a word ends the line. `None` is an
/// unbalanced quote.
fn split_args(s: &str) -> Option<Vec<String>> {
    let chars: Vec<char> = s.chars().collect();
    let mut args = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if BLANKS.contains(&chars[i]) {
            i += 1;
            continue;
        }
        if chars[i] == '#' {
            break;
        }
        let mut arg = String::new();
        let mut quote = None;
        while i < chars.len() {
            let c = chars[i];
            if c == '\\' {
                match chars.get(i + 1) {
                    Some(&next)
                        if matches!(next, '\'' | '"' | '\\')
                            || (quote.is_none() && next == ' ') =>
                    {
                        arg.push(next);
                        i += 2;
                    }
                    _ => {
                        arg.push(c);
                        i += 1;
                    }
                }
                continue;
            }
            match quote {
                None if BLANKS.contains(&c) => break,
                None if c == '"' || c == '\'' => quote = Some(c),
                Some(q) if q == c => quote = None,
                _ => arg.push(c),
            }
            i += 1;
        }
        if quote.is_some() {
            return None;
        }
        args.push(arg);
    }
    Some(args)
}

fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether `ssh` would put a `%` token or `${VAR}` in place in this value. A
/// bare `$` is literal, and `HOST$` is a real account name.
pub fn uses_expansion(text: &str) -> bool {
    text.contains('%') || text.contains("${")
}

/// The file names `arg` of an `Include` line stands for, in glob(3) order.
/// `*` and `?` work in any path component and skip dotfiles unless the
/// component starts with a dot; character classes are refused, not guessed.
fn expand_include(arg: &str, home: &Path) -> Result<Vec<PathBuf>, String> {
    if arg.contains(['[', ']']) {
        return Err("character classes are not supported".to_string());
    }
    if uses_expansion(arg) {
        return Err("tokens and environment variables are not supported".to_string());
    }
    let anchored = if arg == "~" {
        home.to_path_buf()
    } else if let Some(rest) = arg.strip_prefix("~/") {
        home.join(rest)
    } else if arg.starts_with('~') {
        return Err("~user paths are not supported".to_string());
    } else if Path::new(arg).is_absolute() {
        PathBuf::from(arg)
    } else {
        home.join(".ssh").join(arg)
    };

    let mut current = vec![PathBuf::new()];
    for component in anchored.components() {
        let part = component.as_os_str().to_string_lossy();
        if !part.contains(['*', '?']) {
            for path in &mut current {
                path.push(component);
            }
            continue;
        }
        let mut next = Vec::new();
        for dir in &current {
            let Ok(entries) = fs::read_dir(dir) else {
                continue;
            };
            let mut names: Vec<String> = entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|name| !name.starts_with('.') || part.starts_with('.'))
                .filter(|name| wildcard_match(&part, name))
                .collect();
            names.sort();
            next.extend(names.into_iter().map(|name| dir.join(name)));
        }
        // More than the reader will open anyway; it reports the overflow.
        next.truncate(MAX_FILES + 1);
        current = next;
    }
    current.retain(|path| path.exists());
    Ok(current)
}

struct Reader<'a> {
    home: &'a Path,
    /// Canonical paths of the files being read, to refuse an `Include` cycle.
    stack: Vec<PathBuf>,
    bytes_left: u64,
    files: Vec<String>,
    notices: Vec<Notice>,
    unapplied: bool,
}

impl<'a> Reader<'a> {
    fn new(home: &'a Path) -> Self {
        Self {
            home,
            stack: Vec::new(),
            bytes_left: MAX_TOTAL_BYTES,
            files: Vec::new(),
            notices: Vec::new(),
            unapplied: false,
        }
    }

    fn finish(self, statements: Vec<Statement>) -> ParsedConfig {
        ParsedConfig {
            statements,
            notices: self.notices,
            files: self.files,
            unapplied: self.unapplied,
            steps: Cell::new(0),
        }
    }

    /// A path as the user would write it: `~/.ssh/config`.
    fn display(&self, path: &Path) -> String {
        display_path(path, self.home)
    }

    fn notice(&mut self, at: &Source, message: String) {
        let message = match self.notices.len().cmp(&MAX_NOTICES) {
            Ordering::Less => message,
            Ordering::Equal => {
                format!("Lines after these {MAX_NOTICES} were passed over too, and are not listed")
            }
            Ordering::Greater => return,
        };
        self.notices.push(Notice {
            source: at.clone(),
            message,
        });
    }

    /// A notice about something that could change what any host does.
    fn left_out(&mut self, at: &Source, message: String) {
        self.unapplied = true;
        self.notice(at, message);
    }

    /// Read a regular file within the import's limits. The checks come
    /// before the open: an `Include` naming a FIFO must not hang the import
    /// and one naming `/dev/zero` must not fill the memory.
    fn read_bytes(&mut self, path: &Path) -> Result<Vec<u8>, String> {
        let shown = self.display(path);
        let meta = fs::metadata(path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => format!("{shown} does not exist"),
            _ => format!("{shown} could not be read: {e}"),
        })?;
        if !meta.is_file() {
            return Err(format!("{shown} is not a regular file"));
        }
        if self.files.len() >= MAX_FILES {
            return Err(format!(
                "{shown} was not read: an import reads at most {MAX_FILES} files"
            ));
        }
        let too_big = || format!("{shown} was not read: an import reads at most 1 MiB in total");
        if meta.len() > self.bytes_left {
            return Err(too_big());
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .and_then(|file| file.take(self.bytes_left + 1).read_to_end(&mut bytes))
            .map_err(|e| format!("{shown} could not be read: {e}"))?;
        if bytes.len() as u64 > self.bytes_left {
            return Err(too_big());
        }
        self.bytes_left -= bytes.len() as u64;
        self.files.push(shown);
        Ok(bytes)
    }

    fn include_file(&mut self, path: &Path, at: &Source, depth: usize, out: &mut Vec<Statement>) {
        let real = canonical(path);
        if self.stack.contains(&real) {
            let shown = self.display(path);
            self.left_out(
                at,
                format!("Include of {shown} skipped: it would include itself"),
            );
            return;
        }
        if depth >= MAX_INCLUDE_DEPTH {
            let shown = self.display(path);
            self.left_out(
                at,
                format!("Include of {shown} skipped: more than {MAX_INCLUDE_DEPTH} levels deep"),
            );
            return;
        }
        match self.read_bytes(path) {
            Err(why) => self.left_out(at, format!("Include skipped: {why}")),
            Ok(bytes) => {
                self.stack.push(real);
                let file = self.display(path);
                let children = self.parse(&bytes, &file, depth + 1);
                self.stack.pop();
                out.push(Statement::Included(children));
            }
        }
    }

    fn parse(&mut self, bytes: &[u8], file: &str, depth: usize) -> Vec<Statement> {
        let mut out = Vec::new();
        for (index, raw) in bytes.split(|b| *b == b'\n').enumerate() {
            let Some(line) = read_line(raw, index == 0) else {
                continue;
            };
            let at = Source {
                file: file.to_string(),
                line: index + 1,
            };
            match line.keyword.as_str() {
                "host" => match host_patterns(line.args) {
                    Ok(patterns) => out.push(Statement::Host(patterns, at)),
                    Err(why) => {
                        out.push(Statement::Opaque);
                        self.left_out(&at, format!("Host line ignored with its block: {why}"));
                    }
                },
                "match" => {
                    out.push(Statement::Opaque);
                    self.left_out(
                        &at,
                        "Match block skipped: SSIX does not evaluate Match, so its options \
                         were not applied"
                            .to_string(),
                    );
                }
                "include" => {
                    match line.args {
                        Err(why) => self.left_out(&at, format!("Include line ignored: {why}")),
                        Ok(args) => {
                            for arg in args {
                                match expand_include(&arg, self.home) {
                                    Err(why) => self
                                        .left_out(&at, format!("Include of {arg} skipped: {why}")),
                                    Ok(paths) if paths.is_empty() => self
                                        .notice(&at, format!("Include of {arg} matched no files")),
                                    Ok(paths) => {
                                        for path in paths {
                                            self.include_file(&path, &at, depth, &mut out);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                word => {
                    if let Some(keyword) = Keyword::from_lowercase(word) {
                        let args = line.args.map_err(|why| {
                            self.notice(&at, format!("{} line unreadable: {why}", keyword.name()));
                            format!("{} on {at} could not be read: {why}", keyword.name())
                        });
                        out.push(Statement::Directive(
                            keyword,
                            Value {
                                keyword: keyword.name(),
                                args,
                                raw: line.raw,
                                at,
                            },
                        ));
                    }
                }
            }
        }
        out
    }
}

fn host_patterns(args: Result<Vec<String>, String>) -> Result<Vec<Pattern>, String> {
    args?
        .into_iter()
        .map(|arg| {
            let (text, negated) = match arg.strip_prefix('!') {
                Some(rest) => (rest.to_string(), true),
                None => (arg, false),
            };
            if text.is_empty() {
                return Err("it has an empty pattern".to_string());
            }
            Ok(Pattern { text, negated })
        })
        .collect()
}

/// A path as the user would write it, with the home directory as `~`.
pub fn display_path(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

/// A port as OpenSSH's `a2port` reads one: plain digits, 1 to 65535.
pub fn parse_port(text: &str) -> Result<u16, String> {
    let digits_only = !text.is_empty() && text.chars().all(|c| c.is_ascii_digit());
    match text.parse::<u16>() {
        Ok(port) if digits_only && port != 0 => Ok(port),
        _ => Err(format!("'{text}' is not a port between 1 and 65535")),
    }
}

/// Whether `text` can be a host name, by OpenSSH's `valid_hostname` plus the
/// comma it uses to separate hops. Refused here so a name can never reach a
/// shell or a command line as an option.
pub fn valid_host(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= 255
        && !text.starts_with('-')
        && !text
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "'`\"$\\;&<>|(){},".contains(c))
}

/// `[host:]port` or `host:port`, the two ends of a forward directive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardEnd {
    pub host: Option<String>,
    pub port: u16,
}

/// Whether a forward's end names a Unix socket, which SSIX cannot forward.
pub fn is_unix_socket(text: &str) -> bool {
    text.starts_with('/') || text.starts_with('~')
}

/// Read one end of a forward. IPv6 addresses take brackets or `/` for the
/// port, as in `[::1]:80` or `::1/80`.
pub fn parse_forward_end(text: &str) -> Result<ForwardEnd, String> {
    if is_unix_socket(text) {
        return Err(format!(
            "'{text}' is a Unix socket, which SSIX cannot forward"
        ));
    }
    let (host, port) =
        split_host_port(text).ok_or_else(|| format!("'{text}' is not [host:]port"))?;
    Ok(ForwardEnd {
        host: host.filter(|h| !h.is_empty()).map(str::to_string),
        port: parse_port(port.unwrap_or(""))?,
    })
}

/// `host:port`, `[v6]`, `[v6]:port`, `host/port`, or one bare word, which
/// comes back as the second half: a forward reads it as a port and a jump
/// hop as a host.
fn split_host_port(text: &str) -> Option<(Option<&str>, Option<&str>)> {
    if let Some(rest) = text.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        return match after.strip_prefix([':', '/']) {
            Some(port) => Some((Some(host), Some(port))),
            None if after.is_empty() => Some((Some(host), None)),
            None => None,
        };
    }
    if let Some((host, port)) = text.rsplit_once('/') {
        return Some((Some(host), Some(port)));
    }
    match text.split_once(':') {
        None => Some((None, Some(text))),
        Some((host, port)) if !port.contains(':') => Some((Some(host), Some(port))),
        Some(_) => None,
    }
}

/// One `ProxyJump` hop: `[user@]host[:port]` or `ssh://[user@]host[:port]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JumpHop {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
}

/// A `ProxyJump` value without its trailing comment. OpenSSH strips the
/// comment by hand because the option keeps its raw text.
pub fn jump_value(raw: &str) -> &str {
    raw.split('#').next().unwrap_or("").trim()
}

pub fn parse_jump_hop(text: &str) -> Result<JumpHop, String> {
    let invalid = || format!("'{text}' is not a [user@]host[:port] jump host");
    let bare = text.strip_prefix("ssh://").unwrap_or(text);
    let (user, address) = match bare.rsplit_once('@') {
        Some((user, address)) if !user.is_empty() => (Some(user.to_string()), address),
        Some(_) => return Err(invalid()),
        None => (None, bare),
    };
    // Here a single word is the host, not a port as on a forward.
    let (host, port) = match split_host_port(address).ok_or_else(invalid)? {
        (None, Some(word)) => (word, None),
        (Some(host), port) => (host, port),
        (None, None) => return Err(invalid()),
    };
    if !valid_host(host) || host.contains('%') {
        return Err(invalid());
    }
    Ok(JumpHop {
        user,
        host: host.to_string(),
        port: port.map(parse_port).transpose()?,
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::fs;
    use std::path::PathBuf;

    /// A fresh directory that stands in for the user's home.
    pub(crate) struct TempHome(pub(crate) PathBuf);

    impl TempHome {
        pub(crate) fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("ssix-ssh-config-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(dir.join(".ssh")).unwrap();
            Self(fs::canonicalize(dir).unwrap())
        }

        pub(crate) fn write(&self, relative: &str, content: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            path
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::TempHome;
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/home/u")
    }

    fn parse(text: &str) -> ParsedConfig {
        ParsedConfig::parse_text(text, &home())
    }

    fn single(value: &Option<Value>) -> Option<String> {
        value.as_ref().map(|v| v.single().unwrap().to_string())
    }

    fn aliases(config: &ParsedConfig) -> Vec<String> {
        config
            .host_entries()
            .into_iter()
            .filter_map(|e| match e {
                HostEntry::Alias { name, .. } => Some(name),
                HostEntry::Pattern { .. } => None,
            })
            .collect()
    }

    fn patterns(config: &ParsedConfig) -> Vec<String> {
        config
            .host_entries()
            .into_iter()
            .filter_map(|e| match e {
                HostEntry::Pattern { pattern, .. } => Some(pattern),
                HostEntry::Alias { .. } => None,
            })
            .collect()
    }

    #[test]
    fn host_block_with_several_aliases_applies_to_each() {
        let config = parse("Host web web.prod\n  HostName 10.0.0.1\n  User deploy\n");
        assert_eq!(aliases(&config), ["web", "web.prod"]);
        for alias in ["web", "web.prod"] {
            let host = config.resolve(alias);
            assert_eq!(single(&host.host_name).as_deref(), Some("10.0.0.1"));
            assert_eq!(single(&host.user).as_deref(), Some("deploy"));
            assert!(host.named);
        }
    }

    #[test]
    fn first_value_wins_across_blocks() {
        let config = parse(
            "Host web\n  Port 2200\n  Port 2300\nHost web\n  Port 2400\n  User first\nHost *\n  User second\n  Port 22\n",
        );
        let host = config.resolve("web");
        assert_eq!(single(&host.port).as_deref(), Some("2200"));
        assert_eq!(single(&host.user).as_deref(), Some("first"));
    }

    #[test]
    fn host_star_supplies_defaults_only_for_what_is_still_unset() {
        let config = parse(
            "Host web\n  User deploy\nHost db\n  Port 2222\nHost *\n  User fallback\n  Port 22\n  IdentityFile ~/.ssh/id\n",
        );
        let web = config.resolve("web");
        assert_eq!(single(&web.user).as_deref(), Some("deploy"));
        assert_eq!(single(&web.port).as_deref(), Some("22"));
        assert_eq!(web.identity_files.len(), 1);
        let db = config.resolve("db");
        assert_eq!(single(&db.user).as_deref(), Some("fallback"));
        assert_eq!(single(&db.port).as_deref(), Some("2222"));
    }

    #[test]
    fn host_star_first_beats_a_later_block_as_openssh_does() {
        let config = parse("Host *\n  User fallback\nHost web\n  User deploy\n");
        assert_eq!(
            single(&config.resolve("web").user).as_deref(),
            Some("fallback")
        );
    }

    #[test]
    fn options_before_the_first_host_line_apply_to_every_host() {
        let config = parse("User global\nPort 2200\nHost web\n  Port 22\n");
        let web = config.resolve("web");
        assert_eq!(single(&web.user).as_deref(), Some("global"));
        assert_eq!(single(&web.port).as_deref(), Some("2200"));
    }

    #[test]
    fn identity_files_and_forwards_collect_every_value() {
        let config = parse(
            "Host web\n  IdentityFile ~/.ssh/a\n  LocalForward 1 a:1\n  RemoteForward 2 b:2\n  DynamicForward 3\nHost *\n  IdentityFile ~/.ssh/b\n  LocalForward 4 c:4\n",
        );
        let web = config.resolve("web");
        assert_eq!(web.identity_files.len(), 2);
        assert_eq!(web.local_forwards.len(), 2);
        assert_eq!(web.remote_forwards.len(), 1);
        assert_eq!(web.dynamic_forwards.len(), 1);
    }

    #[test]
    fn keywords_are_case_insensitive_and_accept_equals() {
        let config = parse(
            "HOST web\n  hOsTnAmE=10.0.0.1\n  PORT = 2200\n\tuser\t=\tdeploy\n  identityFILE   ~/.ssh/id\n",
        );
        let web = config.resolve("web");
        assert_eq!(single(&web.host_name).as_deref(), Some("10.0.0.1"));
        assert_eq!(single(&web.port).as_deref(), Some("2200"));
        assert_eq!(single(&web.user).as_deref(), Some("deploy"));
        assert_eq!(web.identity_files[0].single().unwrap(), "~/.ssh/id");
    }

    #[test]
    fn quotes_and_comments() {
        let config = parse(
            "# a comment\n\nHost \"quoted host\" plain # trailing\n  IdentityFile \"~/my keys/id\" # why\n  User 'de ploy'\n  HostName 10.0.0.1 # the box\n  Port 22#x\n",
        );
        assert_eq!(aliases(&config), ["quoted host", "plain"]);
        let host = config.resolve("quoted host");
        assert_eq!(host.identity_files[0].single().unwrap(), "~/my keys/id");
        assert_eq!(single(&host.user).as_deref(), Some("de ploy"));
        assert_eq!(single(&host.host_name).as_deref(), Some("10.0.0.1"));
        // `#` only starts a comment at the start of a word.
        assert_eq!(single(&host.port).as_deref(), Some("22#x"));
    }

    #[test]
    fn split_args_matches_argv_split() {
        let split = |s: &str| split_args(s).unwrap();
        assert_eq!(split(r#"a "b c" 'd e'"#), ["a", "b c", "d e"]);
        assert_eq!(split(r#""a"b'c'"#), ["abc"]);
        assert_eq!(split(r"a\ b"), ["a b"]);
        assert_eq!(split(r#"a\"b"#), ["a\"b"]);
        assert_eq!(split(r"a\\b"), [r"a\b"]);
        assert_eq!(split(r"a\qb"), [r"a\qb"]);
        assert_eq!(split(r#""a\ b""#), [r"a\ b"]);
        assert_eq!(split(r#""""#), [""]);
        assert!(split("# only a comment").is_empty());
        assert_eq!(split_args(r#"a "b"#), None);
        assert_eq!(split_args("it's"), None);
    }

    #[test]
    fn proxy_command_keeps_its_raw_text_and_shares_a_slot_with_proxy_jump() {
        let config = parse(
            "Host a\n  ProxyCommand = nc -X connect \"%h\" %p # kept\n  ProxyJump b\nHost b\n  ProxyJump j1,j2\n  ProxyCommand nc %h %p\n",
        );
        match config.resolve("a").proxy {
            Some(Proxy::Command(v)) => assert_eq!(v.raw, "nc -X connect \"%h\" %p # kept"),
            other => panic!("expected the command, got {other:?}"),
        }
        match config.resolve("b").proxy {
            Some(Proxy::Jump(v)) => assert_eq!(v.raw, "j1,j2"),
            other => panic!("expected the jump, got {other:?}"),
        }
    }

    #[test]
    fn none_counts_as_the_first_value() {
        let config = parse("Host bastion\n  ProxyJump none\nHost *\n  ProxyJump bastion\n");
        match config.resolve("bastion").proxy {
            Some(Proxy::Jump(v)) => assert_eq!(v.raw, "none"),
            other => panic!("expected ProxyJump none, got {other:?}"),
        }
    }

    /// Every row compared by hand with `ssh -G` on OpenSSH 10.5.
    #[test]
    fn the_proxy_slot_follows_ssh_in_every_order() {
        for (lines, expected) in [
            (
                "ProxyJump none\nHost *\nProxyCommand corp %h",
                "command corp %h",
            ),
            ("ProxyJump NONE\nProxyCommand corp", "command corp"),
            ("ProxyJump=none\nProxyCommand corp", "command corp"),
            ("ProxyJump none  \nProxyCommand corp", "command corp"),
            (
                "ProxyJump none\nProxyJump j1\nProxyCommand corp",
                "command corp",
            ),
            (
                "ProxyJump none\nProxyCommand a\nProxyCommand b",
                "command a",
            ),
            ("ProxyJump none\nProxyCommand a\nProxyJump j1", "command a"),
            (
                "ProxyJump none\nProxyCommand none\nProxyJump j1\nProxyCommand a",
                "command none",
            ),
            ("ProxyJump none\nProxyJump j1", "jump none"),
            ("ProxyJump j1\nProxyCommand corp", "jump j1"),
            ("ProxyCommand corp\nProxyJump j1", "command corp"),
            ("ProxyCommand none\nProxyJump j1", "command none"),
            ("ProxyCommand none\nProxyCommand corp", "command none"),
            // To `ssh` these two are hops through a host called `none`.
            ("ProxyJump none # why\nProxyCommand corp", "jump none # why"),
            ("ProxyJump \"none\"\nProxyCommand corp", "jump \"none\""),
        ] {
            let config = parse(&format!("Host web\n{lines}\n"));
            let held = match config.resolve("web").proxy {
                Some(Proxy::Jump(v)) => format!("jump {}", v.raw),
                Some(Proxy::Command(v)) => format!("command {}", v.raw),
                None => "nothing".to_string(),
            };
            assert_eq!(held, expected, "{lines:?}");
        }
    }

    #[test]
    fn wildcard_and_negated_patterns_are_not_aliases() {
        let config = parse("Host * db? !prod web\n  User a\nHost *.example.com\n  User b\n");
        assert_eq!(aliases(&config), ["web"]);
        assert_eq!(patterns(&config), ["*", "db?", "!prod", "*.example.com"]);
    }

    #[test]
    fn duplicate_names_are_listed_once() {
        let config = parse("Host web\nHost web db\nHost *\nHost *\n");
        assert_eq!(aliases(&config), ["web", "db"]);
        assert_eq!(patterns(&config), ["*"]);
    }

    #[test]
    fn patterns_apply_and_negation_overrides() {
        let config = parse(
            "Host *.example.com !secret.example.com\n  User wild\nHost db?\n  Port 2200\nHost secret.example.com db1 web.example.com\n",
        );
        assert_eq!(
            single(&config.resolve("web.example.com").user).as_deref(),
            Some("wild")
        );
        assert_eq!(config.resolve("secret.example.com").user.map(|_| ()), None);
        assert_eq!(single(&config.resolve("db1").port).as_deref(), Some("2200"));
        assert_eq!(config.resolve("db12").port.map(|_| ()), None);
    }

    #[test]
    fn a_host_only_named_negatively_is_not_named() {
        let config = parse("Host web !web\n  User a\n");
        let web = config.resolve("web");
        assert!(!web.named);
        assert!(web.user.is_none());
    }

    #[test]
    fn a_host_keeps_a_limited_number_of_forwards_and_remembers_the_first_left_out() {
        let home = std::path::Path::new("/nonexistent-home");
        let mut text = String::from("Host *\n");
        for i in 0..MAX_FORWARDS_PER_HOST + 10 {
            let keyword = [
                "LocalForward 1 d:1",
                "RemoteForward 2 d:2",
                "DynamicForward 3",
            ];
            text.push_str(keyword[i % 3]);
            text.push('\n');
        }
        let config = ParsedConfig::parse_text(&text, home);
        let host = config.resolve("web");
        let held =
            host.local_forwards.len() + host.remote_forwards.len() + host.dynamic_forwards.len();
        assert_eq!(held, MAX_FORWARDS_PER_HOST);
        assert_eq!(
            host.forwards_left_out.map(|at| at.line),
            Some(MAX_FORWARDS_PER_HOST + 2)
        );
    }

    #[test]
    fn a_few_forwards_leave_nothing_out() {
        let config = ParsedConfig::parse_text(
            "Host *\nLocalForward 1 d:1\n",
            std::path::Path::new("/nonexistent-home"),
        );
        assert!(config.resolve("web").forwards_left_out.is_none());
    }

    #[test]
    fn a_host_keeps_a_limited_number_of_identity_files_starting_with_the_first() {
        let text: String = (0..MAX_IDENTITY_FILES + 10)
            .map(|i| format!("IdentityFile /k/{i}\n"))
            .collect();
        let config = ParsedConfig::parse_text(&text, std::path::Path::new("/nonexistent-home"));
        let host = config.resolve("web");
        assert_eq!(host.identity_files.len(), MAX_IDENTITY_FILES);
        assert_eq!(host.identity_files[0].single().unwrap(), "/k/0");
    }

    #[test]
    fn only_what_could_change_a_host_counts_as_unapplied() {
        let home = test_support::TempHome::new();
        home.write(".ssh/inner", "Include inner\n");
        for (text, unapplied) in [
            ("Host a\nUser u\n", false),
            ("Include /nonexistent/file\nHost a\n", false),
            ("Include nothing-here/*\nHost a\n", false),
            ("Host a\nPort \"1\n", false),
            ("Host a\nForwardAgent yes\n", false),
            ("Match all\nUser u\n", true),
            ("Host \"a\nUser u\n", true),
            ("Include \"a\n", true),
            ("Include [ab]\n", true),
            ("Include ~bob/config\n", true),
            ("Include ${HOME}/work/ssh.conf\n", true),
            ("Include %d/work/ssh.conf\n", true),
            ("Include ~/.ssh\n", true),
            ("Include inner\n", true),
        ] {
            let config = ParsedConfig::parse_text(text, &home.0);
            assert_eq!(
                config.unapplied, unapplied,
                "{text:?}: {:?}",
                config.notices
            );
        }
    }

    #[test]
    fn notices_stop_at_the_limit_and_say_so_once() {
        let text = "Match all\n".repeat(MAX_NOTICES + 500);
        let config = ParsedConfig::parse_text(&text, std::path::Path::new("/nonexistent-home"));
        assert_eq!(config.notices.len(), MAX_NOTICES + 1);
        assert!(config.notices[MAX_NOTICES].message.contains("not listed"));
        assert!(config.notices[..MAX_NOTICES]
            .iter()
            .all(|n| !n.message.contains("not listed")));
    }

    #[test]
    fn resolving_counts_its_work_and_adds_it_up() {
        let config = ParsedConfig::parse_text(
            "Host web db\n  User u\nHost *x\n  Port 1\n",
            std::path::Path::new("/nonexistent-home"),
        );
        assert_eq!(config.resolve_steps(), 0);
        config.resolve("web");
        let once = config.resolve_steps();
        // Four statements, two plain patterns, and one wildcard comparison.
        assert!(once >= 4 + 2 + WILDCARD_SETUP_STEPS, "{once}");
        config.resolve("web");
        assert_eq!(config.resolve_steps(), once * 2);
    }

    #[test]
    fn wildcard_matching() {
        for (pattern, text, expected) in [
            ("*", "anything", true),
            ("*", "", true),
            ("", "", true),
            ("", "a", false),
            ("a*", "a", true),
            ("a*c", "abbbc", true),
            ("a*c", "abbbd", false),
            ("a?c", "abc", true),
            ("a?c", "ac", false),
            ("*b*d", "abcd", true),
            ("*.example.com", "web.example.com", true),
            ("*.example.com", "example.com", false),
            ("WEB", "web", false),
        ] {
            assert_eq!(
                wildcard_match(pattern, text),
                expected,
                "{pattern} ~ {text}"
            );
        }
        // Would take forever with naive backtracking.
        let many_stars = "a*".repeat(40) + "b";
        assert!(!wildcard_match(&many_stars, &"a".repeat(4000)));
    }

    #[test]
    fn match_blocks_are_skipped_and_reported() {
        let config = parse(
            "Host web\n  User deploy\nMatch host web exec \"true\"\n  User matched\n  Port 9\nHost db\n  Port 2200\nMatch all\n  HostName wrong\n",
        );
        let web = config.resolve("web");
        assert_eq!(single(&web.user).as_deref(), Some("deploy"));
        assert!(web.port.is_none());
        assert!(web.host_name.is_none());
        assert_eq!(single(&config.resolve("db").port).as_deref(), Some("2200"));
        let lines: Vec<usize> = config.notices.iter().map(|n| n.source.line).collect();
        assert_eq!(lines, [3, 8]);
        assert!(config.notices[0].message.contains("Match"));
    }

    #[test]
    fn crlf_bom_and_form_feed_are_tolerated() {
        let config = parse("\u{feff}Host web\r\n  User deploy\r\n  Port 22\u{c}\r\n");
        let web = config.resolve("web");
        assert_eq!(aliases(&config), ["web"]);
        assert_eq!(single(&web.user).as_deref(), Some("deploy"));
        assert_eq!(single(&web.port).as_deref(), Some("22"));
        assert!(config.notices.is_empty());
    }

    #[test]
    fn unbalanced_quote_poisons_the_option_rather_than_falling_through() {
        let config = parse("Host web\n  Port \"22\n  Port 23\n");
        let web = config.resolve("web");
        let why = web.port.as_ref().unwrap().single().unwrap_err();
        assert!(why.contains("Port on config:2"), "{why}");
        assert!(why.contains("unbalanced quote"), "{why}");
        assert_eq!(config.notices.len(), 1);
    }

    #[test]
    fn long_lines_are_reported_and_never_taken_for_values() {
        let long_user = format!("Host web\n  User {}\n", "x".repeat(MAX_LINE_BYTES * 2));
        let config = parse(&long_user);
        let web = config.resolve("web");
        let why = web.user.as_ref().unwrap().single().unwrap_err();
        assert!(why.contains("longer than 4096"), "{why}");
        assert_eq!(config.notices[0].source.line, 2);
    }

    #[test]
    fn a_long_host_line_starts_a_block_that_applies_to_nothing() {
        let text = format!(
            "Host web\n  User deploy\nHost {}\n  User other\n  Port 9\n",
            "y".repeat(MAX_LINE_BYTES)
        );
        let config = parse(&text);
        let web = config.resolve("web");
        assert_eq!(single(&web.user).as_deref(), Some("deploy"));
        assert!(
            web.port.is_none(),
            "options must not leak into the block before"
        );
        assert_eq!(aliases(&config), ["web"]);
        assert_eq!(config.notices.len(), 1);
    }

    #[test]
    fn invalid_utf8_and_control_characters_are_reported() {
        let mut reader = Reader::new(Path::new("/home/u"));
        let mut bytes = b"Host web\n  User ".to_vec();
        bytes.extend_from_slice(&[0xff, 0xfe, b'\n']);
        bytes.extend_from_slice(b"  Port 2\x00\n  HostName a\x1b[31m\n");
        let statements = reader.parse(&bytes, "config", 0);
        let config = reader.finish(statements);
        let web = config.resolve("web");
        assert!(web
            .user
            .as_ref()
            .unwrap()
            .single()
            .unwrap_err()
            .contains("UTF-8"));
        assert!(web
            .port
            .as_ref()
            .unwrap()
            .single()
            .unwrap_err()
            .contains("control"));
        assert!(web
            .host_name
            .as_ref()
            .unwrap()
            .single()
            .unwrap_err()
            .contains("control"));
        assert_eq!(config.notices.len(), 3);
    }

    #[test]
    fn empty_values_and_empty_patterns_are_reported() {
        let config = parse("Host\nHost \"\"\nHost !\nHost web\n  Port\n  User \"\"\n");
        assert_eq!(aliases(&config), ["web"]);
        // Three Host lines and Port without a value. `User ""` parses; the
        // import refuses the blank name.
        assert_eq!(config.notices.len(), 4);
        let web = config.resolve("web");
        assert!(web.port.as_ref().unwrap().single().is_err());
        assert_eq!(single(&web.user).as_deref(), Some(""));
    }

    #[test]
    fn extra_words_are_kept_for_the_import_to_refuse() {
        let config = parse("Host web\n  Port 22 33\n");
        let why = config.resolve("web").port.unwrap().single().unwrap_err();
        assert!(why.contains("more than one value"), "{why}");
    }

    #[test]
    fn unknown_keywords_are_ignored_silently() {
        let config = parse("Host web\n  ForwardAgent yes\n  Bogus\n  Port 22\n");
        assert!(config.notices.is_empty());
        assert!(config.resolve("web").port.is_some());
    }

    #[test]
    fn include_reads_relative_tilde_absolute_and_glob_paths_in_order() {
        let home = TempHome::new();
        home.write(".ssh/relative", "Host rel\n");
        home.write(".ssh/tilde", "Host til\n");
        let absolute = home.write("elsewhere/abs", "Host abs\n");
        home.write(".ssh/config.d/20-b", "Host glob-b\n");
        home.write(".ssh/config.d/10-a", "Host glob-a\n");
        home.write(".ssh/config.d/.hidden", "Host hidden\n");
        let main = home.write(
            ".ssh/config",
            &format!(
                "Include relative ~/.ssh/tilde\nInclude {}\nInclude config.d/*\nHost main\n",
                absolute.display()
            ),
        );
        let config = ParsedConfig::read(&main, &home.0).unwrap();
        assert_eq!(
            aliases(&config),
            ["rel", "til", "abs", "glob-a", "glob-b", "main"]
        );
        assert!(config.notices.is_empty(), "{:?}", config.notices);
        assert_eq!(config.files[0], "~/.ssh/config");
        assert_eq!(config.files.len(), 6);
    }

    #[test]
    fn include_option_order_is_the_order_of_the_lines() {
        let home = TempHome::new();
        home.write(".ssh/extra", "User included\nHost web\n  Port 2200\n");
        let main = home.write(
            ".ssh/config",
            "Host web\n  Include extra\n  User own\n  Port 2300\n",
        );
        let config = ParsedConfig::read(&main, &home.0).unwrap();
        let web = config.resolve("web");
        // Included first, so its values win over the lines below the Include.
        assert_eq!(single(&web.user).as_deref(), Some("included"));
        assert_eq!(single(&web.port).as_deref(), Some("2200"));
    }

    #[test]
    fn host_in_an_included_file_does_not_leak_into_the_includer() {
        let home = TempHome::new();
        home.write(".ssh/other", "Host other\n  Port 1\n");
        let main = home.write(
            ".ssh/config",
            "Host web\n  Include other\n  User deploy\nHost other\n  User wrong\n",
        );
        let config = ParsedConfig::read(&main, &home.0).unwrap();
        // The block `Host web` is back in force after the include ends.
        assert_eq!(
            single(&config.resolve("web").user).as_deref(),
            Some("deploy")
        );
    }

    #[test]
    fn include_in_a_block_that_does_not_apply_gives_nothing() {
        let home = TempHome::new();
        home.write(".ssh/inner", "Port 1\nHost dead\n  User u\n");
        let main = home.write(
            ".ssh/config",
            "Host conditional\n  Include inner\nHost web\n",
        );
        let config = ParsedConfig::read(&main, &home.0).unwrap();
        let web = config.resolve("web");
        assert!(web.port.is_none());
        assert_eq!(
            single(&config.resolve("conditional").port).as_deref(),
            Some("1")
        );
        // Only ever applies when `Host conditional` already matched, which
        // never holds for `dead`: OpenSSH would ignore this block.
        let dead = config.resolve("dead");
        assert!(!dead.named);
        assert!(dead.user.is_none());
    }

    #[test]
    fn include_cycles_stop_and_are_reported() {
        let home = TempHome::new();
        home.write(".ssh/a", "Host in-a\nInclude b\n");
        home.write(".ssh/b", "Host in-b\nInclude a\nInclude config\n");
        let main = home.write(".ssh/config", "Host top\nInclude a\n");
        let config = ParsedConfig::read(&main, &home.0).unwrap();
        assert_eq!(aliases(&config), ["top", "in-a", "in-b"]);
        let cycles = config
            .notices
            .iter()
            .filter(|n| n.message.contains("include itself"))
            .count();
        assert_eq!(cycles, 2, "{:?}", config.notices);
    }

    #[test]
    fn a_file_including_itself_stops_at_once() {
        let home = TempHome::new();
        let main = home.write(".ssh/config", "Include config\nHost web\n");
        let config = ParsedConfig::read(&main, &home.0).unwrap();
        assert_eq!(aliases(&config), ["web"]);
        assert_eq!(config.notices.len(), 1);
    }

    #[test]
    fn include_chains_stop_at_the_depth_limit() {
        let home = TempHome::new();
        for i in 0..30 {
            home.write(
                &format!(".ssh/chain{i}"),
                &format!("Host hop{i}\nInclude chain{}\n", i + 1),
            );
        }
        let main = home.write(".ssh/config", "Include chain0\n");
        let config = ParsedConfig::read(&main, &home.0).unwrap();
        assert_eq!(aliases(&config).len(), MAX_INCLUDE_DEPTH);
        assert!(config
            .notices
            .iter()
            .any(|n| n.message.contains("levels deep")));
    }

    #[test]
    fn missing_and_unsupported_includes_are_reported() {
        let home = TempHome::new();
        let main = home.write(
            ".ssh/config",
            "Include nope\nInclude ~other/x\nInclude a[bc]\nInclude \"unbalanced\nHost web\n",
        );
        let config = ParsedConfig::read(&main, &home.0).unwrap();
        assert_eq!(aliases(&config), ["web"]);
        assert_eq!(config.notices.len(), 4, "{:?}", config.notices);
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_or_device_in_an_include_is_refused_without_opening_it() {
        let home = TempHome::new();
        let main = home.write(".ssh/config", "Include /dev/zero\nHost web\n");
        let config = ParsedConfig::read(&main, &home.0).unwrap();
        assert_eq!(aliases(&config), ["web"]);
        assert!(config.notices[0].message.contains("not a regular file"));
    }

    #[test]
    fn a_directory_matched_by_a_glob_is_reported() {
        let home = TempHome::new();
        home.write(".ssh/d/sub/file", "Host no\n");
        home.write(".ssh/d/file", "Host yes\n");
        let main = home.write(".ssh/config", "Include d/*\n");
        let config = ParsedConfig::read(&main, &home.0).unwrap();
        assert_eq!(aliases(&config), ["yes"]);
        assert_eq!(config.notices.len(), 1);
    }

    #[test]
    fn the_total_size_limit_applies_across_includes() {
        let home = TempHome::new();
        let blob = "# padding\n".repeat(60_000);
        home.write(".ssh/big1", &blob);
        home.write(".ssh/big2", &blob);
        let main = home.write(".ssh/config", "Include big1 big2\nHost web\n");
        let config = ParsedConfig::read(&main, &home.0).unwrap();
        assert_eq!(aliases(&config), ["web"]);
        assert!(config.notices.iter().any(|n| n.message.contains("1 MiB")));
    }

    #[test]
    fn the_file_limit_applies_across_includes() {
        let home = TempHome::new();
        for i in 0..80 {
            home.write(&format!(".ssh/many/{i:03}"), "");
        }
        let main = home.write(".ssh/config", "Include many/*\n");
        let config = ParsedConfig::read(&main, &home.0).unwrap();
        assert_eq!(config.files.len(), MAX_FILES);
        assert!(config.notices.iter().any(|n| n.message.contains("at most")));
    }

    #[test]
    fn a_missing_or_oversized_top_level_file_is_an_error() {
        let home = TempHome::new();
        let missing = ParsedConfig::read(&home.0.join(".ssh/none"), &home.0).unwrap_err();
        assert!(missing.contains("~/.ssh/none does not exist"), "{missing}");
        let directory = ParsedConfig::read(&home.0.join(".ssh"), &home.0).unwrap_err();
        assert!(directory.contains("not a regular file"), "{directory}");
        let big = home.write(".ssh/big", &"#\n".repeat(600_000));
        assert!(ParsedConfig::read(&big, &home.0)
            .unwrap_err()
            .contains("1 MiB"));
    }

    #[test]
    fn ports() {
        assert_eq!(parse_port("22"), Ok(22));
        assert_eq!(parse_port("65535"), Ok(65535));
        for bad in [
            "",
            "0",
            "65536",
            "-1",
            "+22",
            "abc",
            "22a",
            " 22",
            "99999999999999",
        ] {
            assert!(parse_port(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn host_names() {
        for good in ["web", "10.0.0.1", "::1", "web-1.example.com", "ünï"] {
            assert!(valid_host(good), "{good}");
        }
        let long = "a".repeat(256);
        for bad in [
            "",
            "-oProxyCommand=x",
            "a b",
            "a;b",
            "a$b",
            "a`b",
            "a|b",
            "a,b",
            "a'b",
            "a\tb",
            long.as_str(),
        ] {
            assert!(!valid_host(bad), "{bad}");
        }
    }

    #[test]
    fn forward_ends() {
        let end = |host: Option<&str>, port| ForwardEnd {
            host: host.map(str::to_string),
            port,
        };
        assert_eq!(parse_forward_end("8080"), Ok(end(None, 8080)));
        assert_eq!(parse_forward_end("db:5432"), Ok(end(Some("db"), 5432)));
        assert_eq!(parse_forward_end("*:80"), Ok(end(Some("*"), 80)));
        assert_eq!(parse_forward_end(":80"), Ok(end(None, 80)));
        assert_eq!(parse_forward_end("[::1]:80"), Ok(end(Some("::1"), 80)));
        assert_eq!(parse_forward_end("[::1]/80"), Ok(end(Some("::1"), 80)));
        assert_eq!(parse_forward_end("::1/80"), Ok(end(Some("::1"), 80)));
        assert!(parse_forward_end("/tmp/sock").unwrap_err().contains("Unix"));
        assert!(parse_forward_end("~/sock").unwrap_err().contains("Unix"));
        for bad in [
            "", "db", "db:", "db:abc", "db:0", "db:70000", "::1", "[::1]", "[::1", "[::1]x",
        ] {
            assert!(parse_forward_end(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn jump_hops() {
        let hop = |user: Option<&str>, host: &str, port| JumpHop {
            user: user.map(str::to_string),
            host: host.to_string(),
            port,
        };
        assert_eq!(parse_jump_hop("bastion"), Ok(hop(None, "bastion", None)));
        assert_eq!(
            parse_jump_hop("ops@bastion:2222"),
            Ok(hop(Some("ops"), "bastion", Some(2222)))
        );
        assert_eq!(
            parse_jump_hop("ssh://ops@bastion:2222"),
            Ok(hop(Some("ops"), "bastion", Some(2222)))
        );
        assert_eq!(parse_jump_hop("[::1]:22"), Ok(hop(None, "::1", Some(22))));
        assert_eq!(parse_jump_hop("a@b@c"), Ok(hop(Some("a@b"), "c", None)));
        for bad in [
            "", "@host", "host:abc", "host:0", "a;b", "-oX", "%h", "[::1",
        ] {
            assert!(parse_jump_hop(bad).is_err(), "{bad}");
        }
        assert_eq!(jump_value("bastion # the way in"), "bastion");
        assert_eq!(jump_value("  a,b  "), "a,b");
    }

    /// Whatever the bytes, the reader returns: no panic on a char boundary,
    /// quote or number. A small deterministic generator, weighted toward
    /// the characters the parser treats specially.
    #[test]
    fn arbitrary_input_never_panics() {
        const PIECES: &[&[u8]] = &[
            b"Host ",
            b"Match ",
            b"Include ",
            b"HostName ",
            b"Port ",
            b"User ",
            b"IdentityFile ",
            b"ProxyJump ",
            b"ProxyCommand ",
            b"LocalForward ",
            b"RemoteForward ",
            b"DynamicForward ",
            b"\n",
            b"\r\n",
            b"\"",
            b"'",
            b"\\",
            b"#",
            b"=",
            b"*",
            b"?",
            b"!",
            b"%",
            b"[",
            b"]",
            b":",
            b"/",
            b"~",
            b"@",
            b",",
            b" ",
            b"\t",
            b"\0",
            b"\xff",
            b"\xc3",
            b"\xa9",
            "é".as_bytes(),
            "\u{1F511}".as_bytes(),
            b"22",
            b"web",
            b"-",
        ];
        let mut state: u64 = 0x5eed;
        let mut next = move || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as usize
        };
        let home = PathBuf::from("/nonexistent-home");
        for _ in 0..400 {
            let mut bytes = Vec::new();
            for _ in 0..(next() % 80) {
                bytes.extend_from_slice(PIECES[next() % PIECES.len()]);
            }
            let mut reader = Reader::new(&home);
            let statements = reader.parse(&bytes, "config", 0);
            let config = reader.finish(statements);
            for entry in config.host_entries() {
                if let HostEntry::Alias { name, .. } = entry {
                    let host = config.resolve(&name);
                    if let Some(port) = host.port {
                        let _ = port.single().map(parse_port);
                    }
                    for args in host.local_forwards.iter().flat_map(|f| f.args.iter()) {
                        for arg in args {
                            let _ = parse_forward_end(arg);
                        }
                    }
                    if let Some(Proxy::Jump(v)) = &host.proxy {
                        let _ = parse_jump_hop(jump_value(&v.raw));
                    }
                }
            }
        }
    }
}
