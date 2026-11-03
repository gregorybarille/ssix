import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { errorMessage } from "@/lib/errors";
import { openExternalUrl } from "@/lib/externalLinks";
import {
  APP_AUTHOR,
  APP_LICENSE,
  APP_LICENSE_URL,
  APP_REPOSITORY_URL,
  appVersion,
  filterPackages,
  loadThirdPartyPackages,
  type ThirdPartyPackage,
} from "@/lib/appInfo";

/** A link that opens in the default browser: the webview itself never leaves the app. */
function BrowserLink({
  url,
  label,
  testId,
  onError,
}: {
  url: string;
  label: string;
  testId: string;
  onError: (message: string) => void;
}) {
  return (
    <Button
      type="button"
      variant="link"
      className="h-auto gap-1 p-0"
      data-testid={testId}
      onClick={() => {
        openExternalUrl(url).catch((error) => onError(errorMessage(error)));
      }}
    >
      {label}
      <ExternalLink aria-hidden="true" className="h-3 w-3" />
    </Button>
  );
}

/** The searchable list of what ships inside SSIX, loaded when first opened. */
function ThirdPartyLicenses({ packages }: { packages: ThirdPartyPackage[] }) {
  const [query, setQuery] = useState("");
  const shown = filterPackages(packages, query);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground-soft">
        The licence each one declares. Where several are listed with OR, SSIX
        uses it under any one of them.
      </p>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter by name or licence"
        aria-label="Filter third-party libraries by name or licence"
        data-testid="about-licenses-filter"
      />
      <ul
        tabIndex={0}
        aria-label="Third-party libraries and their licences"
        className="max-h-64 divide-y overflow-y-auto rounded-md border text-xs"
        data-testid="about-licenses-list"
      >
        {shown.map((pkg) => (
          <li
            key={`${pkg.source}:${pkg.name}:${pkg.version ?? ""}`}
            className="flex items-baseline justify-between gap-4 px-2 py-1"
            data-testid="about-license-row"
            data-name={pkg.name}
          >
            <span className="min-w-0 break-words">
              {pkg.name}
              {pkg.version && (
                <span className="text-muted-foreground-soft"> {pkg.version}</span>
              )}
            </span>
            <span className="shrink-0 text-right text-muted-foreground">{pkg.license}</span>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="px-2 py-1 text-muted-foreground">Nothing matches.</li>
        )}
      </ul>
    </div>
  );
}

/** Who makes SSIX, which version this is, and the licences of what it is built from. */
export function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [packages, setPackages] = useState<ThirdPartyPackage[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    appVersion()
      .then((found) => {
        if (alive) setVersion(found);
      })
      .catch(() => {
        // Only the line below loses out: it says the version is not known.
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = () => {
    setOpen(!open);
    if (packages) return;
    setLoadError(null);
    loadThirdPartyPackages()
      .then(setPackages)
      .catch((error) => setLoadError(errorMessage(error)));
  };

  return (
    <div
      className="space-y-4"
      role="group"
      aria-labelledby="settings-about-heading"
      data-testid="settings-about"
    >
      <h3 id="settings-about-heading" className="text-sm font-medium">About</h3>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Version</dt>
        <dd data-testid="about-version">{version ?? "Unknown"}</dd>
        <dt className="text-muted-foreground">Author</dt>
        <dd data-testid="about-author">{APP_AUTHOR}</dd>
        <dt className="text-muted-foreground">Source code</dt>
        <dd>
          <BrowserLink
            url={APP_REPOSITORY_URL}
            label="github.com/gregorybarille/ssix"
            testId="about-repository-link"
            onError={setLinkError}
          />
        </dd>
        <dt className="text-muted-foreground">Licence</dt>
        <dd>
          <BrowserLink
            url={APP_LICENSE_URL}
            label={APP_LICENSE}
            testId="about-license-link"
            onError={setLinkError}
          />
        </dd>
      </dl>
      {linkError && (
        <p role="alert" className="text-sm text-destructive">
          {linkError}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        data-testid="about-licenses-toggle"
        onClick={toggle}
      >
        {open ? "Hide third-party licences" : "Show third-party licences"}
      </Button>
      {open && loadError && (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      )}
      {open && packages && <ThirdPartyLicenses packages={packages} />}
    </div>
  );
}
