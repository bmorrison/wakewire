import { describe, expect, it } from "vitest";
import {
  buildServicePath,
  escapeXmlText,
  launchdPlist,
  quoteSystemdArg,
  quoteSystemdValue,
  systemdUnit,
} from "./service.js";

describe("buildServicePath", () => {
  it("prepends dirname of execPath and appends macOS standard directories", () => {
    const execPath = "/Users/burkmorrison/.asdf/installs/nodejs/24.7.0/bin/node";
    const inheritedPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin";
    const result = buildServicePath(execPath, inheritedPath, "darwin");

    expect(result).toBe(
      [
        "/Users/burkmorrison/.asdf/installs/nodejs/24.7.0/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
    );
  });

  it("appends Linux standard directories for linux platform", () => {
    const execPath = "/usr/local/node/bin/node";
    const inheritedPath = "/custom/bin:/usr/bin";
    const result = buildServicePath(execPath, inheritedPath, "linux");

    expect(result).toBe(
      ["/usr/local/node/bin", "/custom/bin", "/usr/bin", "/usr/local/bin", "/bin"].join(":"),
    );
  });

  it("drops relative entries and empty elements", () => {
    const execPath = "/home/user/.nvm/versions/node/v20.18.0/bin/node";
    const inheritedPath = ":relative/dir:.:/usr/bin::../another/dir:";
    const result = buildServicePath(execPath, inheritedPath, "linux");

    expect(result).toBe(
      ["/home/user/.nvm/versions/node/v20.18.0/bin", "/usr/bin", "/usr/local/bin", "/bin"].join(
        ":",
      ),
    );
  });

  it("checks inherited entries as raw paths without changing whitespace in valid names", () => {
    const execPath = "/opt/node/bin/node";
    const inheritedPath = ":/valid path: /tmp/attacker:/trailing-space ::relative:";
    const result = buildServicePath(execPath, inheritedPath, "linux");

    expect(result).toBe(
      [
        "/opt/node/bin",
        "/valid path",
        "/trailing-space ",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ].join(":"),
    );
  });

  it("deduplicates while preserving first occurrence", () => {
    const execPath = "/usr/bin/node";
    const inheritedPath = "/usr/bin:/usr/local/bin:/usr/bin:/bin";
    const result = buildServicePath(execPath, inheritedPath, "darwin");

    expect(result).toBe(["/usr/bin", "/usr/local/bin", "/bin", "/usr/sbin", "/sbin"].join(":"));
  });

  it("handles undefined and empty inherited path", () => {
    const execPath = "/opt/bin/node";
    const resultUndefined = buildServicePath(execPath, undefined, "darwin");
    expect(resultUndefined).toBe(
      ["/opt/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    );

    const resultEmpty = buildServicePath(execPath, "", "darwin");
    expect(resultEmpty).toBe(
      ["/opt/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    );
  });
});

describe("escapeXmlText", () => {
  it("escapes &, <, > while preserving spaces and quotes", () => {
    const input = "a & b < c > d \"e\" 'f'";
    expect(escapeXmlText(input)).toBe("a &amp; b &lt; c &gt; d \"e\" 'f'");
  });

  it("rejects NUL and invalid XML control characters", () => {
    expect(() => escapeXmlText("hello\0world")).toThrow(/control character/i);
    expect(() => escapeXmlText("hello\x01world")).toThrow(/control character/i);
    expect(() => escapeXmlText("hello\x1Fworld")).toThrow(/control character/i);
  });
});

describe("quoteSystemdValue and quoteSystemdArg", () => {
  it("quotes values, escapes backslashes and double quotes, and encodes percent signs", () => {
    const input = 'PATH=/opt/bin with spaces/and"quotes"/%n\\slash';
    const quoted = quoteSystemdValue(input);
    expect(quoted).toBe('"PATH=/opt/bin with spaces/and\\"quotes\\"/%%n\\\\slash"');
  });

  it("rejects NUL and newlines", () => {
    expect(() => quoteSystemdValue("path\0invalid")).toThrow(/newline|NUL/i);
    expect(() => quoteSystemdValue("path\ninvalid")).toThrow(/newline|NUL/i);
    expect(() => quoteSystemdValue("path\rinvalid")).toThrow(/newline|NUL/i);
    expect(() => quoteSystemdArg("arg\0invalid")).toThrow(/newline|NUL/i);
    expect(() => quoteSystemdArg("arg\ninvalid")).toThrow(/newline|NUL/i);
  });
});

describe("launchdPlist", () => {
  it("renders valid plist XML containing EnvironmentVariables PATH before ProgramArguments", () => {
    const cliPath = "/Users/burkmorrison/Projects/wakewire/dist/cli.js";
    const servicePath = "/Users/burkmorrison/.asdf/installs/nodejs/24.7.0/bin:/usr/bin:/bin";
    const xml = launchdPlist(cliPath, servicePath);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<key>Label</key><string>io.wakewire.daemon</string>");
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain(`<key>PATH</key><string>${servicePath}</string>`);
    expect(xml).toContain("<key>ProgramArguments</key>");
    expect(xml).toContain(`<string>${cliPath}</string>`);
    expect(xml).toContain("<string>start</string>");

    const envIndex = xml.indexOf("<key>EnvironmentVariables</key>");
    const progIndex = xml.indexOf("<key>ProgramArguments</key>");
    expect(envIndex).toBeGreaterThan(0);
    expect(progIndex).toBeGreaterThan(envIndex);
  });

  it("escapes dynamic XML values in plist", () => {
    const cliPath = "/path/with & < >/cli.js";
    const servicePath = "/bin & < >:/usr/bin";
    const xml = launchdPlist(cliPath, servicePath);

    expect(xml).toContain("/path/with &amp; &lt; &gt;/cli.js");
    expect(xml).toContain("/bin &amp; &lt; &gt;:/usr/bin");
  });
});

describe("systemdUnit", () => {
  it("renders systemd unit with quoted Environment and ExecStart", () => {
    const cliPath = "/home/user/wakewire/dist/cli.js";
    const servicePath = "/home/user/.nvm/bin:/usr/bin:/bin";
    const unit = systemdUnit(cliPath, servicePath);

    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain(`Environment="PATH=${servicePath}"`);
    expect(unit).toContain(`ExecStart="${process.execPath}" "${cliPath}" "start"`);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("escapes percent signs and spaces in systemdUnit paths", () => {
    const cliPath = "/home/user/app%20dir/dist/cli.js";
    const servicePath = "/home/user/node%20bin:/usr/bin";
    const unit = systemdUnit(cliPath, servicePath);

    expect(unit).toContain('Environment="PATH=/home/user/node%%20bin:/usr/bin"');
    expect(unit).toContain('"/home/user/app%%20dir/dist/cli.js"');
  });
});
