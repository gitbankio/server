import satori from "/tmp/node_modules/satori/dist/index.js";
import { Resvg } from "/tmp/node_modules/@resvg/resvg-js/index.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const BLUE = "#2222FF";
const DARK = "#0a0a14";

const fontRegular = readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf");
const fontBold    = readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf");
const fonts = [
  { name: "DejaVu", data: fontRegular, weight: 400, style: "normal" },
  { name: "DejaVu", data: fontBold,    weight: 700, style: "normal" },
];

// ── helper ────────────────────────────────────────────────────────────────────
function el(type, style, children, extra = {}) {
  return {
    type,
    props: {
      style: { display: "flex", ...style },
      ...extra,
      children: Array.isArray(children) ? children : (children !== undefined ? [children] : []),
    },
  };
}
function t(text, style = {}) {
  return { type: "span", props: { style: { fontFamily: "DejaVu", ...style }, children: String(text) } };
}

// ── Gitbank cat logo ──────────────────────────────────────────────────────────
function logo(size = 36) {
  const s = size / 180;
  return {
    type: "svg",
    props: {
      width: size, height: size, viewBox: "0 0 180 180",
      style: { flexShrink: 0 },
      children: [
        { type: "rect", props: { width: 180, height: 180, rx: 36, fill: BLUE } },
        { type: "path", props: { d: "M54 72 L66 54 L78 72Z", fill: "white" } },
        { type: "path", props: { d: "M102 72 L114 54 L126 72Z", fill: "white" } },
        { type: "ellipse", props: { cx: 90, cy: 98, rx: 40, ry: 36, fill: "white" } },
        { type: "path", props: { d: "M82 72 Q90 80 98 72", fill: BLUE } },
        { type: "circle", props: { cx: 76, cy: 100, r: 8, fill: BLUE } },
        { type: "circle", props: { cx: 104, cy: 100, r: 8, fill: BLUE } },
      ],
    },
  };
}

function badge(text, bg = BLUE, color = "white") {
  return el("div", {
    background: bg, color, borderRadius: 6,
    padding: "5px 13px",
    fontSize: 11, fontWeight: 700, letterSpacing: 2,
    textTransform: "uppercase",
  }, t(text, { color, fontWeight: 700 }));
}

function pill(text, bg, color) {
  return el("div", {
    background: bg, borderRadius: 6,
    padding: "3px 10px", marginRight: 6,
    fontSize: 10, fontWeight: 700,
  }, t(text, { color, fontWeight: 700 }));
}

// ─────────────────────────────────────────────────────────────────────────────
// INFOGRAPHIC 1: EIP-1167
// ─────────────────────────────────────────────────────────────────────────────
function eip1167Tree() {
  // vault icon mini
  const vaultSmall = (accent = false) => el("div", {
    width: 72, height: 72, borderRadius: 10,
    background: accent ? BLUE : "white",
    border: `2px solid ${accent ? BLUE : "#d1d5db"}`,
    alignItems: "center", justifyContent: "center",
    flexDirection: "column", gap: 4, flexShrink: 0,
  }, [
    el("div", { fontSize: 22 }, t("🔒", { fontSize: 22 })),
    t("VAULT", { fontSize: 8, fontWeight: 700, color: accent ? "white" : BLUE }),
  ]);

  const cloneBox = () => el("div", {
    width: 38, height: 38, borderRadius: 6,
    background: "rgba(255,255,255,0.2)",
    border: "1.5px solid rgba(255,255,255,0.35)",
    alignItems: "center", justifyContent: "center",
  }, t("45b", { fontSize: 8, fontWeight: 700, color: "rgba(255,255,255,0.85)" }));

  const cloneRow = () => el("div", { gap: 4 }, [
    el("div", { width: 14, height: 2, background: "rgba(255,255,255,0.35)", alignSelf: "center" }),
    cloneBox(), cloneBox(), cloneBox(),
  ]);

  return el("div", {
    width: 1200, height: 675,
    background: "#eef0f8",
    flexDirection: "column",
    padding: "40px 52px 34px",
    position: "relative",
    fontFamily: "DejaVu",
  }, [
    // ── header ──
    el("div", { justifyContent: "space-between", alignItems: "center", marginBottom: 22 }, [
      el("div", { alignItems: "center", gap: 12 }, [
        logo(36),
        t("Gitbank", { fontSize: 20, fontWeight: 700, color: DARK }),
      ]),
      badge("EIP-1167 Minimal Proxy"),
    ]),

    // ── title ──
    el("div", { flexDirection: "column", marginBottom: 24 }, [
      t("How Gitbank deploys 1000+ vaults without spending a fortune on gas", {
        fontSize: 11, color: "#6b7280", letterSpacing: 1, marginBottom: 8,
      }),
      el("div", { gap: 8 }, [
        t("One Contract. ", { fontSize: 34, fontWeight: 700, color: DARK }),
        t("Infinite Vaults.", { fontSize: 34, fontWeight: 700, color: BLUE }),
      ]),
    ]),

    // ── comparison ──
    el("div", { gap: 16, flex: 1 }, [
      // Left: old way
      el("div", {
        flex: 1, background: "white", border: "1.5px solid #e5e7eb",
        borderRadius: 14, padding: "20px 22px", flexDirection: "column",
      }, [
        pill("Old Way", "#fee2e2", "#991b1b"),
        t("Full deploy per user", { fontSize: 15, fontWeight: 700, color: DARK, marginTop: 12, marginBottom: 6 }),
        t("Each vault = full bytecode redeployed. Expensive, redundant, does not scale.", {
          fontSize: 12, color: "#6b7280", lineHeight: 1.5,
        }),
        el("div", { flexWrap: "wrap", gap: 8, marginTop: 16, flex: 1 }, [
          vaultSmall(), vaultSmall(), vaultSmall(),
          vaultSmall(), vaultSmall(), vaultSmall(),
        ]),
        el("div", {
          background: "#fef2f2", border: "1px solid #fecaca",
          borderRadius: 10, padding: "12px 16px", marginTop: 16,
          flexDirection: "column",
        }, [
          t("Gas cost per vault", { fontSize: 11, color: "#ef4444", fontWeight: 700, marginBottom: 4 }),
          t("$50 to $500", { fontSize: 28, fontWeight: 700, color: "#dc2626" }),
          t("500k to 1M gas each", { fontSize: 11, color: "#ef4444", marginTop: 2 }),
        ]),
      ]),

      // VS
      el("div", { width: 72, alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, flexShrink: 0 }, [
        el("div", {
          width: 44, height: 44, borderRadius: 22,
          background: BLUE, alignItems: "center", justifyContent: "center",
        }, t("VS", { fontSize: 13, fontWeight: 700, color: "white" })),
      ]),

      // Right: Gitbank way
      el("div", {
        flex: 1, background: BLUE,
        borderRadius: 14, padding: "20px 22px", flexDirection: "column",
      }, [
        pill("Gitbank Way", "rgba(255,255,255,0.2)", "white"),
        t("One implementation, infinite clones", { fontSize: 15, fontWeight: 700, color: "white", marginTop: 12, marginBottom: 6 }),
        t("45-byte proxy per user. Points to one master contract. Each clone has its own storage, shares the logic.", {
          fontSize: 12, color: "rgba(255,255,255,0.82)", lineHeight: 1.5,
        }),
        el("div", { alignItems: "center", gap: 12, marginTop: 16, flex: 1 }, [
          vaultSmall(true),
          el("div", { flexDirection: "column", gap: 4 }, [
            cloneRow(), cloneRow(), cloneRow(),
          ]),
        ]),
        el("div", {
          background: "rgba(255,255,255,0.15)", borderRadius: 10,
          padding: "12px 16px", marginTop: 16, flexDirection: "column",
        }, [
          t("Gas cost per vault", { fontSize: 11, color: "rgba(255,255,255,0.7)", fontWeight: 700, marginBottom: 4 }),
          t("~$0.50", { fontSize: 28, fontWeight: 700, color: "white" }),
          t("~50k gas each. 10x cheaper.", { fontSize: 11, color: "rgba(255,255,255,0.7)", marginTop: 2 }),
        ]),
      ]),
    ]),

    // ── footer ──
    el("div", {
      justifyContent: "space-between", alignItems: "center",
      marginTop: 14, paddingTop: 14,
      borderTop: "1.5px solid rgba(0,0,0,0.08)",
    }, [
      el("div", { gap: 6 }, [
        t("Implementation: ", { fontSize: 11, color: "#6b7280" }),
        t("0x3602197A1b445AA4746c47C9D69436d9B7cF5dc9", { fontSize: 11, color: BLUE, fontWeight: 700, fontFamily: "monospace" }),
        t(" verified on Basescan", { fontSize: 11, color: "#6b7280" }),
      ]),
      el("div", { alignItems: "center", gap: 8 }, [
        logo(20),
        t("gitbank.io", { fontSize: 12, fontWeight: 700, color: BLUE }),
      ]),
    ]),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// INFOGRAPHIC 2: Quantum Defense
// ─────────────────────────────────────────────────────────────────────────────
function quantumTree() {
  function layer(num, title, body, footer, bgBlue = false, pillBg, pillColor) {
    return el("div", {
      flex: 1,
      background: bgBlue ? BLUE : "white",
      border: bgBlue ? "none" : "1.5px solid #e5e7eb",
      borderRadius: 12,
      padding: "18px 20px",
      flexDirection: "column",
      gap: 0,
    }, [
      pill(num, pillBg, pillColor),
      t(title, { fontSize: 15, fontWeight: 700, color: bgBlue ? "white" : DARK, marginTop: 10, marginBottom: 6 }),
      t(body, { fontSize: 12, color: bgBlue ? "rgba(255,255,255,0.82)" : "#4b5563", lineHeight: 1.55, flex: 1 }),
      t(footer, { fontSize: 11, fontWeight: 700, color: bgBlue ? "white" : (num.includes("3") ? BLUE : "#d97706"), marginTop: 12 }),
    ]);
  }

  const attackStep = (text) => t(text, { fontSize: 12, fontWeight: 700, color: "#374151" });
  const arrow = () => t("  →  ", { fontSize: 14, color: "#9ca3af", fontWeight: 700 });

  return el("div", {
    width: 1200, height: 675,
    background: "#eef0f8",
    flexDirection: "column",
    padding: "40px 52px 34px",
    fontFamily: "DejaVu",
  }, [
    // header
    el("div", { justifyContent: "space-between", alignItems: "center", marginBottom: 22 }, [
      el("div", { alignItems: "center", gap: 12 }, [
        logo(36),
        t("Gitbank", { fontSize: 20, fontWeight: 700, color: DARK }),
      ]),
      badge("Security Model"),
    ]),

    // title
    el("div", { flexDirection: "column", marginBottom: 22 }, [
      t("Quantum Computing Threat Response", { fontSize: 11, color: "#6b7280", letterSpacing: 1, marginBottom: 8 }),
      el("div", { gap: 8 }, [
        t("Quantum breaks your key. ", { fontSize: 34, fontWeight: 700, color: DARK }),
        t("Not your vault.", { fontSize: 34, fontWeight: 700, color: BLUE }),
      ]),
    ]),

    // attack chain
    el("div", {
      background: "rgba(34,34,255,0.06)", border: "1.5px solid rgba(34,34,255,0.15)",
      borderRadius: 10, padding: "12px 20px", alignItems: "center",
      marginBottom: 20,
    }, [
      t("ATTACK PATH  ", { fontSize: 10, fontWeight: 700, color: "#ef4444", letterSpacing: 2 }),
      attackStep("Quantum Computer"),
      arrow(),
      attackStep("Breaks secp256k1"),
      arrow(),
      attackStep("Derives Private Key"),
      arrow(),
      attackStep("Attempts vault drain"),
      t("  →  ", { fontSize: 14, color: "#9ca3af", fontWeight: 700 }),
      el("div", {
        background: "#ef4444", borderRadius: 6,
        padding: "5px 12px",
      }, t("BLOCKED", { fontSize: 11, fontWeight: 700, color: "white", letterSpacing: 1 })),
    ]),

    // three layers
    el("div", { gap: 14, flex: 1 }, [
      layer(
        "LAYER 1",
        "Owner Keypair",
        "Quantum can derive the private key from the on-chain public key via Shor's algorithm. Key alone is not enough.",
        "Partial attack surface only",
        false, "#fef3c7", "#92400e"
      ),
      layer(
        "LAYER 2 REQUIRED",
        "Identity Verification",
        "Every vault op requires relayer co-signature. Relayer verifies GitHub or X account via OAuth. Quantum does not break OAuth sessions.",
        "GitHub ID  |  X (Twitter) ID",
        true, "rgba(255,255,255,0.2)", "white"
      ),
      layer(
        "LAYER 3",
        "Keys Never On-Chain",
        "Vault keypairs stored AES-256-GCM encrypted server-side. No on-chain public key = no Shor input. Different threat model from standard wallets.",
        "AES-256-GCM encrypted",
        false, "rgba(34,34,255,0.08)", BLUE
      ),
    ]),

    // footer
    el("div", {
      justifyContent: "space-between", alignItems: "center",
      marginTop: 14, paddingTop: 14,
      borderTop: "1.5px solid rgba(0,0,0,0.08)",
    }, [
      t("Vault identity anchored to immutable GitHub / X user ID. 2-signature meta-tx model on Base Mainnet.", {
        fontSize: 11, color: "#6b7280", fontStyle: "italic",
      }),
      el("div", { alignItems: "center", gap: 8 }, [
        logo(20),
        t("gitbank.io", { fontSize: 12, fontWeight: 700, color: BLUE }),
      ]),
    ]),
  ]);
}

// ── Render ────────────────────────────────────────────────────────────────────
async function render(tree, filename) {
  const svg = await satori(tree, {
    width: 1200, height: 675,
    fonts,
    embedFont: true,
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 2400 },   // 2x HD
    font: { loadSystemFonts: false },
  });
  const png = resvg.render().asPng();
  writeFileSync(filename, png);
  console.log(`Wrote ${filename} (${Math.round(png.length / 1024)}KB)`);
}

mkdirSync("/home/runner/workspace/public", { recursive: true });

await render(eip1167Tree(),   "/home/runner/workspace/public/infographic-eip1167.png");
await render(quantumTree(),   "/home/runner/workspace/public/infographic-quantum.png");
console.log("Done.");
