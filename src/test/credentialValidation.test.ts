import { describe, it, expect } from "vitest";
import { credentialFieldErrors } from "@/lib/credentialValidation";

describe("credentialFieldErrors", () => {
  it("accepts a complete password credential", () => {
    expect(
      credentialFieldErrors({ name: "prod", username: "root", type: "password", password: "x" }),
    ).toEqual({});
  });

  it("requires a name and a username, ignoring surrounding spaces", () => {
    expect(credentialFieldErrors({ name: "  ", username: " ", type: "password" })).toEqual({
      name: "Credential name is required",
      username: "Username is required",
    });
  });

  it("skips the name for an unnamed (private) credential", () => {
    expect(credentialFieldErrors({ name: null, username: "root", type: "password" })).toEqual({});
  });

  it("rejects a name that is already taken", () => {
    expect(
      credentialFieldErrors(
        { name: " prod ", username: "root", type: "password" },
        { takenNames: ["prod"] },
      ),
    ).toEqual({ name: "A credential named 'prod' already exists" });
  });

  it("only requires a password when asked to", () => {
    const draft = { name: null, username: "root", type: "password" as const, password: "" };
    expect(credentialFieldErrors(draft)).toEqual({});
    expect(credentialFieldErrors(draft, { requirePassword: true })).toEqual({
      password: "Password is required",
    });
  });

  it("requires a key path for a path-based SSH key", () => {
    expect(
      credentialFieldErrors({ name: null, username: "root", type: "ssh_key", privateKeyPath: " " }),
    ).toEqual({ key_path: "Private key path is required" });
  });

  it("requires inline key contents unless the stored secrets are kept", () => {
    const draft = {
      name: null,
      username: "root",
      type: "ssh_key" as const,
      keySource: "inline" as const,
      privateKey: "",
    };
    expect(credentialFieldErrors(draft)).toEqual({
      key_inline: "Private key contents are required",
    });
    expect(credentialFieldErrors(draft, { keepSecrets: true })).toEqual({});
  });
});
