import { type ReactNode } from "react";

const ROOT_ID = "keybr-root";

export function Root({
  children,
}: {
  readonly children?: ReactNode;
}): ReactNode {
  return <div id={ROOT_ID}>{children}</div>;
}

Root.selector = `#${ROOT_ID}`;
