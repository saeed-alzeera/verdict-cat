import { Button, Dialog, TextField } from "@keybr/widget";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useState } from "react";

export const GITHUB_TOKEN_KEY = "keybr_github_token";

export function GitHubSync(): ReactNode {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");

  useEffect(() => {
    if (!localStorage.getItem(GITHUB_TOKEN_KEY)) {
      setOpen(true);
    }
  }, []);

  const save = useCallback(() => {
    const t = token.trim();
    if (t) {
      localStorage.setItem(GITHUB_TOKEN_KEY, t);
      setOpen(false);
      window.location.reload();
    }
  }, [token]);

  const skip = useCallback(() => {
    setOpen(false);
  }, []);

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter") save();
    },
    [save],
  );

  if (!open) return null;

  return (
    <Dialog onClose={skip}>
      <div style={{ padding: "1.5rem", maxWidth: "420px" }}>
        <h2 style={{ marginTop: 0 }}>Enable cross-device sync</h2>
        <p style={{ fontSize: "0.9rem", lineHeight: 1.5 }}>
          Paste a GitHub Personal Access Token to sync your typing history and
          settings across devices via this repo.
          <br />
          <br />
          Create one at{" "}
          <strong>
            github.com → Settings → Developer settings → Personal access tokens
          </strong>
          . Choose <em>fine-grained</em>, scope it to{" "}
          <strong>saeed-alzeera/verdict-cat</strong>, and grant{" "}
          <strong>Contents: Read and write</strong>.
        </p>
        <TextField
          type="password"
          placeholder="github_pat_..."
          value={token}
          onChange={setToken}
          onKeyDown={handleKey}
        />
        <div
          style={{
            marginTop: "1rem",
            display: "flex",
            gap: "0.5rem",
            justifyContent: "flex-end",
          }}
        >
          <Button label="Skip for now" onClick={skip} />
          <Button label="Save & reload" onClick={save} />
        </div>
      </div>
    </Dialog>
  );
}
