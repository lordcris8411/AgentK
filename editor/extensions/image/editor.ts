import { defineEditor } from "../../sdk";
import "./editor.css";

function displayBytes(value?: number): string {
  if (value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

defineEditor((host, initial) => {
  if (!initial.binary) throw new Error("The image plugin requires binary file data");
  document.documentElement.dataset.theme = initial.theme;
  const url = URL.createObjectURL(new Blob([initial.binary], { type: initial.mimeType }));
  host.root.className = "image-editor";

  const toolbar = document.createElement("header");
  toolbar.className = "image-toolbar";
  const channels = ["RGB", "R", "G", "B", "A"] as const;
  const channelButtons = channels.map((channel) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = channel;
    toolbar.append(button);
    return button;
  });
  channelButtons[0]?.classList.add("active");
  const fitButton = document.createElement("button");
  fitButton.type = "button";
  fitButton.textContent = initial.locale === "en-US" ? "Fit" : "适应";
  const zoomLabel = document.createElement("span");
  zoomLabel.textContent = "100%";
  toolbar.append(fitButton, zoomLabel);

  const stage = document.createElement("div");
  stage.className = "image-stage";
  const canvas = document.createElement("canvas");
  stage.append(canvas);
  const info = document.createElement("footer");
  info.className = "image-info";
  host.root.append(toolbar, stage, info);

  const image = new Image();
  let original: ImageData | undefined;
  let scale = 1;
  let targetScale = 1;
  let zoomAnimation: number | undefined;
  let selected: typeof channels[number] = "RGB";
  const renderScale = (nextScale: number) => {
    scale = nextScale;
    canvas.style.transform = `translate3d(-50%, -50%, 0) scale(${nextScale})`;
    zoomLabel.textContent = `${Math.round(nextScale * 100)}%`;
  };
  const fit = () => {
    if (!canvas.width || !canvas.height) return;
    if (zoomAnimation !== undefined) cancelAnimationFrame(zoomAnimation);
    zoomAnimation = undefined;
    targetScale = Math.max(.05, Math.min(1, (stage.clientWidth - 36) / canvas.width, (stage.clientHeight - 36) / canvas.height));
    renderScale(targetScale);
  };
  const animateScaleBy = (amount: number) => {
    const pendingDirection = Math.sign(targetScale - scale);
    const requestedDirection = Math.sign(amount);
    const startingScale =
      zoomAnimation === undefined ||
      (pendingDirection !== 0 && pendingDirection !== requestedDirection)
        ? scale
        : targetScale;
    targetScale = Math.max(.05, Math.min(4, startingScale + amount));
    if (zoomAnimation !== undefined) return;
    const animate = () => {
      const nextScale = scale + (targetScale - scale) * .16;
      const finished = Math.abs(targetScale - nextScale) < .0005;
      renderScale(finished ? targetScale : nextScale);
      if (finished) {
        zoomAnimation = undefined;
        return;
      }
      zoomAnimation = requestAnimationFrame(animate);
    };
    zoomAnimation = requestAnimationFrame(animate);
  };
  const renderChannel = () => {
    if (!original) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const pixels = new ImageData(new Uint8ClampedArray(original.data), original.width, original.height);
    if (selected !== "RGB") {
      for (let offset = 0; offset < pixels.data.length; offset += 4) {
        const red = pixels.data[offset] ?? 0;
        const green = pixels.data[offset + 1] ?? 0;
        const blue = pixels.data[offset + 2] ?? 0;
        const alpha = pixels.data[offset + 3] ?? 0;
        pixels.data[offset] = selected === "R" ? red : selected === "A" ? alpha : 0;
        pixels.data[offset + 1] = selected === "G" ? green : selected === "A" ? alpha : 0;
        pixels.data[offset + 2] = selected === "B" ? blue : selected === "A" ? alpha : 0;
        if (selected === "A") pixels.data[offset + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
  };
  image.addEventListener("load", () => {
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context?.drawImage(image, 0, 0);
    original = context?.getImageData(0, 0, canvas.width, canvas.height);
    info.textContent = `${canvas.width} × ${canvas.height} px · ${displayBytes(initial.byteSize)}`;
    fit();
  });
  image.src = url;
  channelButtons.forEach((button, index) => button.addEventListener("click", () => {
    selected = channels[index] ?? "RGB";
    channelButtons.forEach((candidate) => candidate.classList.toggle("active", candidate === button));
    renderChannel();
  }));
  fitButton.addEventListener("click", fit);
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1);
    animateScaleBy(-delta * .00035);
  }, { passive: false });

  return {
    dispose() {
      if (zoomAnimation !== undefined) cancelAnimationFrame(zoomAnimation);
      URL.revokeObjectURL(url);
    },
    getContent: () => "",
    setContent: () => undefined,
    setTheme(theme) {
      document.documentElement.dataset.theme = theme;
    },
  };
});
