/**
 * Renders a version's `*phrase*` marker as the page's own emphasis
 * (docs/specs/design-preserving-rewrite.md): the snippet writes the phrase
 * into the page's emphasis element, so every preview shows it that way and
 * never the raw asterisks. A template renders as its words, never its tokens.
 */
import { isTemplate, templateParts, templatePlain } from "@/lib/template-view";

export function Marked({ text }: { text: string }) {
  if (isTemplate(text)) return <TemplateText template={text} />;
  const parts = text.split(/(\*[^*\n]{1,80}\*)/);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("*") && part.endsWith("*") && part.length > 2 ? (
          <em
            // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
            key={i}
            className="italic underline decoration-[3px] decoration-state-success/70 underline-offset-[5px]"
          >
            {part.slice(1, -1)}
          </em>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <span key={i}>{part.replace(/\*/g, "")}</span>
        ),
      )}
    </>
  );
}

/** The plain words of a marked string, for places that cannot render markup (titles, tooltips). */
export function unmarked(text: string | null | undefined): string {
  if (isTemplate(text)) return templatePlain(text ?? "");
  return (text ?? "").replace(/\*/g, "");
}

/**
 * A headline built word by word (docs/specs/template-writing.md §4.5): its
 * words, a small ring where the page shows an image, the page's line breaks,
 * the words it styles apart in the muted tone, and the rotating word with its
 * alternatives on hover.
 */
function TemplateText({ template }: { template: string }) {
  return (
    <>
      {templateParts(template).map((p, i) => {
        // biome-ignore lint/suspicious/noArrayIndexKey: static parse of one string
        if (p.kind === "br") return <br key={i} />;
        if (p.kind === "glyph")
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: static parse of one string
              key={i}
              aria-hidden="true"
              title="an image on your page"
              className="mx-[0.12em] inline-block size-[0.62em] rounded-full border-2 border-current align-[-0.04em] opacity-50"
            />
          );
        if (p.kind === "rot")
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: static parse of one string
              key={i}
              title={`Rotates: ${p.alts.join(" · ")}`}
              className={`underline decoration-dotted underline-offset-[5px] ${p.styled ? "text-fg-muted" : ""}`}
            >
              {p.alts[0]}
            </span>
          );
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: static parse of one string
          <span key={i} className={p.styled ? "text-fg-muted" : undefined}>
            {p.text}
          </span>
        );
      })}
    </>
  );
}
