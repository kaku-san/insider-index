import { initialsFor } from "@/lib/fomo/portraits";
import { cn } from "@/lib/utils";

export function PersonAvatar({
  name,
  imageUrl,
  size = "md",
}: {
  name: string;
  imageUrl?: string | null;
  size?: "sm" | "md" | "lg";
}) {
  const dim = size === "lg" ? "size-16" : size === "sm" ? "size-8" : "size-11";
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={name}
        className={cn("shrink-0 rounded-full object-cover object-top ring-1 ring-white/15", dim)}
      />
    );
  }
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-emerald-400/20 text-xs font-semibold text-emerald-100 ring-1 ring-white/15",
        dim,
      )}
    >
      {initialsFor(name)}
    </span>
  );
}
