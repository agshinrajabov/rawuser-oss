import { codeParts } from "@/lib/install";

/** Text whose `backticked` spans render in the mono face (lib/install.ts). */
export function Codey({ text }: { text: string }) {
  return (
    <>
      {codeParts(text).map((p, i) =>
        p.code ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
          <code key={i} className="font-mono text-[0.92em]">
            {p.text}
          </code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}
