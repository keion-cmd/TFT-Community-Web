const INITIALS_PALETTE = [
  "#2c4870",
  "#7c3aed",
  "#0891b2",
  "#be185d",
  "#b45309",
  "#15803d",
  "#4338ca",
  "#c2410c",
];

function colorForSeed(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return INITIALS_PALETTE[Math.abs(hash) % INITIALS_PALETTE.length];
}

function initialsFor(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const SIZE_CLASSES = {
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-14 w-14 text-lg",
} as const;

export interface AvatarProps {
  name: string;
  src?: string | null;
  size?: keyof typeof SIZE_CLASSES;
  online?: boolean;
  className?: string;
}

export function Avatar({ name, src, size = "md", online, className = "" }: AvatarProps) {
  return (
    <span className={`relative inline-flex shrink-0 ${className}`}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={name}
          className={`rounded-full object-cover ${SIZE_CLASSES[size]}`}
        />
      ) : (
        <span
          className={`flex items-center justify-center rounded-full font-semibold text-accent-foreground ${SIZE_CLASSES[size]}`}
          style={{ backgroundColor: colorForSeed(name || "?") }}
        >
          {initialsFor(name)}
        </span>
      )}
      {online !== undefined && (
        <span
          aria-hidden
          className={`absolute right-0 bottom-0 h-2.5 w-2.5 rounded-full border-2 border-background ${
            online ? "bg-success" : "bg-muted-foreground"
          }`}
        />
      )}
    </span>
  );
}
