/**
 * A sentence as it was written, its address made a mail link (the words
 * unchanged). Without an address, or when the sentence does not hold it, the
 * sentence is drawn as plain text.
 */
export function MailLinked({
  text,
  address,
  className,
}: {
  text: string;
  address: string | null;
  className?: string;
}) {
  const i = address ? text.indexOf(address) : -1;
  if (!address || i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <a href={`mailto:${address}`} className={className}>
        {address}
      </a>
      {text.slice(i + address.length)}
    </>
  );
}
