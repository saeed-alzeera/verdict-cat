import { memo, type ReactNode } from "react";

export const slot1 = "keybr_728x90_970x90_ATF";
export const slot2 = "keybr_160x600_Left";

export type AdDetails = {
  readonly id: string;
  readonly width: number;
  readonly height: number;
};

export const inventory: Record<string, AdDetails> = {
  BANNER_970X90_1: { id: slot1, width: 970, height: 90 },
  BANNER_160X600_1: { id: slot2, width: 160, height: 600 },
};

export function SetupAds({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  if (process.env.NODE_ENV === "development") {
    return null;
  }
  const html =
    `var freestar=freestar||{};` +
    `freestar.hitTime=Date.now();` +
    `freestar.queue=freestar.queue||[];` +
    `freestar.config=freestar.config||{};` +
    `freestar.config.enabled_slots=["${slot1}","${slot2}"];`;
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: html }} />
      {children}
    </>
  );
}

export const AdBanner = memo(function AdBanner(_: {
  readonly name: "BANNER_160X600_1" | "BANNER_970X90_1";
}): ReactNode {
  return null;
});
