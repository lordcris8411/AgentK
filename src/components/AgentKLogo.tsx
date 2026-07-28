import type { CSSProperties } from "react";
import primaryMask from "../../assets/icons/icon-primary-mask.png";
import secondaryMask from "../../assets/icons/icon-secondary-mask.png";

const maskStyle = (source: string): CSSProperties => ({
  maskImage: `url("${source}")`,
  WebkitMaskImage: `url("${source}")`,
});

export function AgentKLogo({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={["agent-k-logo", className].filter(Boolean).join(" ")}
    >
      <span className="agent-k-logo-layer agent-k-logo-primary" style={maskStyle(primaryMask)} />
      <span className="agent-k-logo-layer agent-k-logo-secondary" style={maskStyle(secondaryMask)} />
    </span>
  );
}
