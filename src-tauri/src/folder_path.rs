//! What a connection's folder path may look like. A folder is only a path
//! on its connections, so these rules are all there is to one.
//!
//! `src/lib/folders.ts` holds the same rules for the form's inline errors;
//! both are tested against `src/test/fixtures/folder-paths.json`, which fails
//! whichever side changes alone. See `docs/folders.md`.

const MAX_CHARS: usize = 512;
const MAX_DEPTH: usize = 10;

fn segments(raw: &str) -> impl Iterator<Item = &str> {
    raw.split(['/', '\\'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
}

fn is_dot_segment(segment: &str) -> bool {
    segment == "." || segment == ".."
}

/// Refuse a path, already in its stored form, that is too long or too deep.
pub(crate) fn check_limits(path: &str) -> Result<(), String> {
    if path.chars().count() > MAX_CHARS {
        return Err(format!(
            "A folder path can be at most {MAX_CHARS} characters"
        ));
    }
    if path.split('/').count() > MAX_DEPTH {
        return Err(format!("Folders can nest at most {MAX_DEPTH} levels"));
    }
    Ok(())
}

/// The stored form of a typed path (`" /prod / eu// "` is `prod/eu`), `None`
/// when it is blank, or why it cannot be used.
pub(crate) fn parse(raw: &str) -> Result<Option<String>, String> {
    if raw.chars().any(char::is_control) {
        return Err("A folder path cannot contain control characters".to_string());
    }
    let parts: Vec<&str> = segments(raw).collect();
    if parts.iter().any(|segment| is_dot_segment(segment)) {
        return Err("A folder cannot be named . or ..".to_string());
    }
    if parts.is_empty() {
        return Ok(None);
    }
    let path = parts.join("/");
    check_limits(&path)?;
    Ok(Some(path))
}

/// The stored form of a path that must name a folder.
pub(crate) fn parse_required(raw: &str) -> Result<String, String> {
    parse(raw)?.ok_or_else(|| "A folder path is required".to_string())
}

/// A path found in `data.json`, which a hand edit or an older build could
/// have left outside the rules. It must never stop the app from loading, so
/// whatever `parse` would refuse is cut away rather than reported.
pub(crate) fn sanitize_stored(raw: &str) -> Option<String> {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    let mut parts: Vec<String> = segments(&cleaned)
        .filter(|segment| !is_dot_segment(segment))
        .take(MAX_DEPTH)
        .map(str::to_string)
        .collect();
    while parts.join("/").chars().count() > MAX_CHARS {
        if parts.len() > 1 {
            parts.pop();
        } else {
            let cut: String = parts[0].chars().take(MAX_CHARS).collect();
            parts[0] = cut.trim_end().to_string();
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Whether `folder` is `path` or lies somewhere under it. Paths are compared
/// exactly: `Prod` is not `prod`, and `production` is not under `prod`.
pub(crate) fn is_within(folder: &str, path: &str) -> bool {
    folder
        .strip_prefix(path)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// The folder holding `path`, `None` at the top.
pub(crate) fn parent(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(parent, _)| parent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Repeat {
        text: String,
        times: usize,
    }

    #[derive(Deserialize)]
    struct Case {
        input: Option<String>,
        repeat: Option<Repeat>,
        path: Option<String>,
        #[serde(default)]
        unset: bool,
        #[serde(default)]
        same: bool,
        error: Option<String>,
    }

    #[derive(Deserialize)]
    struct RenameCase {
        from: String,
        to: String,
        error: Option<String>,
    }

    #[derive(Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
        renames: Vec<RenameCase>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!("../../src/test/fixtures/folder-paths.json")).unwrap()
    }

    fn input_of(case: &Case) -> String {
        match (&case.input, &case.repeat) {
            (Some(input), _) => input.clone(),
            (None, Some(repeat)) => repeat.text.repeat(repeat.times),
            (None, None) => panic!("a case needs input or repeat"),
        }
    }

    #[test]
    fn paths_follow_the_rules_the_frontend_is_tested_against() {
        for case in fixture().cases {
            let input = input_of(&case);
            let expected = if let Some(error) = case.error {
                Err(error)
            } else if case.unset {
                Ok(None)
            } else if case.same {
                Ok(Some(input.clone()))
            } else {
                Ok(Some(case.path.expect("a case states its outcome")))
            };
            assert_eq!(parse(&input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn renames_follow_the_rules_the_frontend_is_tested_against() {
        for case in fixture().renames {
            let result = crate::commands::folders::check_rename(&case.from, &case.to).map(|_| ());
            assert_eq!(result, case.error.map_or(Ok(()), Err), "to: {:?}", case.to);
        }
    }

    #[test]
    fn a_stored_path_is_always_cut_down_to_a_valid_one() {
        let long_segment = "x".repeat(600);
        let many_segments = vec!["seg"; 40].join("/");
        let wide = vec!["y".repeat(100); 9].join("/");
        for raw in [
            "prod/eu",
            "/prod//eu/",
            "prod\\eu",
            "prod/../eu",
            "../..",
            ".",
            "pr\u{7}od\n/eu",
            "\n",
            "",
            "   ",
            long_segment.as_str(),
            many_segments.as_str(),
            wide.as_str(),
        ] {
            let cleaned = sanitize_stored(raw);
            if let Some(path) = &cleaned {
                assert_eq!(parse(path).as_ref(), Ok(&cleaned), "from {raw:?}");
            }
            let again = cleaned.as_deref().and_then(sanitize_stored);
            assert_eq!(again, cleaned, "must be stable, from {raw:?}");
        }
    }

    #[test]
    fn stored_paths_keep_as_much_as_the_rules_allow() {
        assert_eq!(sanitize_stored("prod/../eu").as_deref(), Some("prod/eu"));
        assert_eq!(sanitize_stored("pr\u{7}od\n").as_deref(), Some("prod"));
        assert_eq!(sanitize_stored("../.."), None);
        assert_eq!(sanitize_stored("\n"), None);
        let deep = sanitize_stored("a/b/c/d/e/f/g/h/i/j/k/l").unwrap();
        assert_eq!(deep, "a/b/c/d/e/f/g/h/i/j");
        let wide = vec!["y".repeat(100); 9].join("/");
        let kept = sanitize_stored(&wide).unwrap();
        assert_eq!(kept.split('/').count(), 5);
        let long = sanitize_stored(&"x".repeat(600)).unwrap();
        assert_eq!(long.chars().count(), 512);
    }

    #[test]
    fn within_compares_whole_segments_exactly() {
        assert!(is_within("prod", "prod"));
        assert!(is_within("prod/eu", "prod"));
        assert!(is_within("prod/eu/west", "prod/eu"));
        assert!(!is_within("production", "prod"));
        assert!(!is_within("Prod/eu", "prod"));
        assert!(!is_within("prod", "prod/eu"));
    }

    #[test]
    fn parent_is_one_level_up() {
        assert_eq!(parent("prod/eu/west"), Some("prod/eu"));
        assert_eq!(parent("prod"), None);
    }
}
