import { usePageData } from "@keybr/pages-shared";
import { Article, Button, Icon, TextField } from "@keybr/widget";
import { mdiContentCopy, mdiDelete, mdiDownload, mdiSend } from "@mdi/js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import * as styles from "./TextTransportPage.module.less";

type Snippet = {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
};

const STORAGE_KEY = "text-transport-snippets";

function loadFromLocalStorage(): Snippet[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Snippet[];
    }
  } catch {
    // ignore parse errors
  }
  return [];
}

function saveToLocalStorage(snippets: Snippet[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snippets));
  } catch {
    // ignore storage errors
  }
}

export function TextTransportPage() {
  const { user } = usePageData();
  const { formatMessage } = useIntl();
  const [text, setText] = useState("");
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectAllRef = useRef<HTMLInputElement>(null);

  const isAuthenticated = user != null;

  const updateSnippets = useCallback((updated: Snippet[]) => {
    setSnippets(updated);
    saveToLocalStorage(updated);
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      fetch("/_/text-transport", { headers: { Accept: "application/json" } })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (Array.isArray(data)) {
            setSnippets(data as Snippet[]);
            saveToLocalStorage(data as Snippet[]);
          } else {
            setSnippets(loadFromLocalStorage());
          }
        })
        .catch(() => {
          setSnippets(loadFromLocalStorage());
        });
    } else {
      setSnippets(loadFromLocalStorage());
    }
  }, [isAuthenticated]);

  const handleSave = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (isAuthenticated) {
      try {
        const res = await fetch("/_/text-transport", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed }),
        });
        if (res.ok) {
          const snippet = (await res.json()) as Snippet;
          const updated = [snippet, ...snippets];
          updateSnippets(updated);
          setText("");
          return;
        }
      } catch {
        // fall through to local-only save
      }
    }

    const snippet: Snippet = {
      id: crypto.randomUUID(),
      text: trimmed,
      createdAt: new Date().toISOString(),
    };
    updateSnippets([snippet, ...snippets]);
    setText("");
  }, [text, snippets, isAuthenticated, updateSnippets]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (isAuthenticated) {
        try {
          await fetch(`/_/text-transport/${id}`, { method: "DELETE" });
        } catch {
          // continue with local delete regardless
        }
      }
      updateSnippets(snippets.filter((s) => s.id !== id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [snippets, isAuthenticated, updateSnippets],
  );

  const handleCopy = useCallback(async (id: string, content: string) => {
    await navigator.clipboard.writeText(content);
    setCopied(id);
    setTimeout(() => setCopied((prev) => (prev === id ? null : prev)), 2000);
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.size === snippets.length && snippets.length > 0
        ? new Set()
        : new Set(snippets.map((s) => s.id)),
    );
  }, [snippets]);

  const handleDeleteSelected = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (isAuthenticated) {
      await Promise.all(
        ids.map((id) =>
          fetch(`/_/text-transport/${id}`, { method: "DELETE" }).catch(
            () => {},
          ),
        ),
      );
    }
    updateSnippets(snippets.filter((s) => !selectedIds.has(s.id)));
    setSelectedIds(new Set());
  }, [selectedIds, snippets, isAuthenticated, updateSnippets]);

  useEffect(() => {
    if (selectAllRef.current) {
      const allSelected =
        selectedIds.size === snippets.length && snippets.length > 0;
      selectAllRef.current.indeterminate =
        selectedIds.size > 0 && !allSelected;
    }
  }, [selectedIds, snippets.length]);

  const handleExport = useCallback(() => {
    const blob = new Blob([JSON.stringify(snippets, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "text-snippets.json";
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [snippets]);

  return (
    <Article>
      <h1>
        {formatMessage({
          id: "t_Text_Transport",
          defaultMessage: "Text Transport",
        })}
      </h1>

      <p>
        {formatMessage({
          id: "page.textTransport.intro",
          defaultMessage:
            "Paste text on one device and copy it on another. Each snippet is saved and ready to copy.",
        })}
      </p>

      <div className={styles.inputArea}>
        <TextField
          type="textarea"
          value={text}
          onChange={setText}
          placeholder={formatMessage({
            id: "page.textTransport.placeholder",
            defaultMessage: "Paste or type your text here...",
          })}
          rows={6}
        />
        <div className={styles.saveRow}>
          <Button
            disabled={!text.trim()}
            onClick={handleSave}
            icon={<Icon shape={mdiSend} />}
            label={formatMessage({
              id: "page.textTransport.save",
              defaultMessage: "Save",
            })}
          />
        </div>
      </div>

      {!isAuthenticated && (
        <p className={styles.notice}>
          {formatMessage({
            id: "page.textTransport.signInNotice",
            defaultMessage:
              "Sign in to sync snippets across all your devices. Currently saving to this browser only.",
          })}
        </p>
      )}

      {snippets.length > 0 && (
        <section className={styles.snippetList}>
          <div className={styles.snippetListHeader}>
            <h2>
              {formatMessage({
                id: "page.textTransport.savedSnippets",
                defaultMessage: "Saved Snippets",
              })}
            </h2>
            <div className={styles.headerActions}>
              <label className={styles.selectAllLabel}>
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={
                    selectedIds.size === snippets.length && snippets.length > 0
                  }
                  onChange={toggleSelectAll}
                />
                {formatMessage({
                  id: "page.textTransport.selectAll",
                  defaultMessage: "Select all",
                })}
              </label>
              {selectedIds.size > 0 && (
                <Button
                  onClick={handleDeleteSelected}
                  icon={<Icon shape={mdiDelete} />}
                  label={formatMessage(
                    {
                      id: "page.textTransport.deleteSelected",
                      defaultMessage: "Delete selected ({count})",
                    },
                    { count: selectedIds.size },
                  )}
                  title={formatMessage({
                    id: "page.textTransport.deleteSelectedTitle",
                    defaultMessage: "Delete all selected snippets",
                  })}
                />
              )}
              <Button
                onClick={handleExport}
                icon={<Icon shape={mdiDownload} />}
                label={formatMessage({
                  id: "page.textTransport.exportJson",
                  defaultMessage: "Export JSON",
                })}
                title={formatMessage({
                  id: "page.textTransport.exportJsonTitle",
                  defaultMessage: "Download all snippets as JSON",
                })}
              />
            </div>
          </div>
          {snippets.map((snippet) => (
            <div key={snippet.id} className={styles.snippetCard}>
              <pre className={styles.snippetText}>{snippet.text}</pre>
              <div className={styles.snippetFooter}>
                <label className={styles.snippetCheckbox}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(snippet.id)}
                    onChange={() => toggleSelect(snippet.id)}
                  />
                </label>
                <span className={styles.snippetDate}>
                  {new Date(snippet.createdAt).toLocaleString()}
                </span>
                <div className={styles.snippetActions}>
                  <Button
                    onClick={() => handleCopy(snippet.id, snippet.text)}
                    icon={<Icon shape={mdiContentCopy} />}
                    label={
                      copied === snippet.id
                        ? formatMessage({
                            id: "page.textTransport.copied",
                            defaultMessage: "Copied!",
                          })
                        : formatMessage({
                            id: "page.textTransport.copy",
                            defaultMessage: "Copy",
                          })
                    }
                    title={formatMessage({
                      id: "page.textTransport.copyTitle",
                      defaultMessage: "Copy to clipboard",
                    })}
                  />
                  <Button
                    onClick={() => handleDelete(snippet.id)}
                    icon={<Icon shape={mdiDelete} />}
                    label={formatMessage({
                      id: "page.textTransport.delete",
                      defaultMessage: "Delete",
                    })}
                    title={formatMessage({
                      id: "page.textTransport.deleteTitle",
                      defaultMessage: "Delete this snippet",
                    })}
                  />
                </div>
              </div>
            </div>
          ))}
        </section>
      )}
    </Article>
  );
}
