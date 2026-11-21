import { useEffect, useRef, useState } from "react";

type Example = { title: string; code: string };

export function exampleConfigurations(endpoint: string, token: string): Example[] {
  const header = `Authorization: Bearer ${token}`;
  const cursor = JSON.stringify(
    { mcpServers: { knowlify: { url: endpoint, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
  const desktop = JSON.stringify(
    {
      mcpServers: {
        knowlify: {
          command: "npx",
          args: ["-y", "mcp-remote", endpoint, "--header", header],
        },
      },
    },
    null,
    2,
  );
  return [
    { title: "Claude Code", code: `claude mcp add --transport http knowlify ${endpoint} --header "${header}"` },
    { title: "Cursor", code: cursor },
    { title: "Claude Desktop (mcp-remote)", code: desktop },
  ];
}

async function writeClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    document.body.append(field);
    try {
      field.select();
      document.execCommand("copy");
    } finally {
      field.remove();
    }
  }
}

function CopyBlock({ title, code }: Example) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await writeClipboard(code);
    } catch {
      // Clipboard access can be blocked; keep the snippet selectable either way.
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="mcp-example">
      <div className="mcp-example-head">
        <h4>{title}</h4>
        <button
          type="button"
          className="ghost bordered mcp-copy"
          aria-label={`Copy ${title}`}
          onClick={() => void copy()}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
      <span className="visually-hidden" role="status">
        {copied ? `${title} copied to clipboard.` : ""}
      </span>
    </div>
  );
}

/**
 * Ready-to-paste connection examples. `token` is passed only by the one-time
 * reveal dialog; everywhere else the snippet keeps the `<YOUR_TOKEN>` placeholder.
 */
export function McpExamples({ endpoint, token }: { endpoint: string; token?: string }) {
  const secret = token ?? "<YOUR_TOKEN>";
  return (
    <details className="mcp-examples">
      <summary>Connection examples</summary>
      <p className="mcp-hint">
        {token
          ? "The token from this window is filled in below."
          : "Replace <YOUR_TOKEN> with a token you created."}
      </p>
      {exampleConfigurations(endpoint, secret).map((example) => (
        <CopyBlock key={example.title} {...example} />
      ))}
    </details>
  );
}
