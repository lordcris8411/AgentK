import { useEffect, useRef, useState } from "react";
import { useSettings } from "../../features/settings/SettingsContext";

export type PreviewKind = "image" | "pdf" | "audio" | "video";
type ImageChannel = "RGB" | "R" | "G" | "B" | "A";

function formatTime(value: number) {
  if (!Number.isFinite(value)) return "0:00";
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatBytes(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function formatBitrate(byteSize?: number, duration?: number) {
  if (!byteSize || !duration || !Number.isFinite(duration)) return "—";
  const bitsPerSecond = (byteSize * 8) / duration;
  if (bitsPerSecond >= 1_000_000)
    return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

function mediaFormat(name: string) {
  return (name.split(".").pop() || "FILE").toUpperCase();
}

function greatestCommonDivisor(left: number, right: number) {
  let a = Math.max(1, Math.round(left));
  let b = Math.max(1, Math.round(right));
  while (b) [a, b] = [b, a % b];
  return a;
}

function aspectRatio(width: number, height: number) {
  if (!width || !height) return "—";
  const divisor = greatestCommonDivisor(width, height);
  const left = width / divisor;
  const right = height / divisor;
  return left <= 40 && right <= 40
    ? `${left}:${right}`
    : `${(width / height).toFixed(2)}:1`;
}

function MediaInfo({
  items,
}: {
  items: Array<{ label: string; value: string }>;
}) {
  return (
    <dl className="media-info-strip">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ImagePreview({
  byteSize,
  name,
  url,
}: {
  byteSize?: number;
  name: string;
  url: string;
}) {
  const { settings } = useSettings();
  const en = settings.locale === "en-US";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | undefined>(undefined);
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomAnimationRef = useRef<number | undefined>(undefined);
  const targetScaleRef = useRef(1);
  const currentScaleRef = useRef(1);
  const [channel, setChannel] = useState<ImageChannel>("RGB");
  const [scale, setScale] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [availableSize, setAvailableSize] = useState({ width: 0, height: 0 });
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const channels: ImageChannel[] = [
    "png",
    "webp",
    "gif",
    "ico",
    "svg",
  ].includes(extension)
    ? ["RGB", "R", "G", "B", "A"]
    : ["RGB", "R", "G", "B"];

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => {
      const next = {
        height: Math.max(0, stage.clientHeight - 36),
        width: Math.max(0, stage.clientWidth - 36),
      };
      setAvailableSize((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (zoomAnimationRef.current !== undefined) {
      cancelAnimationFrame(zoomAnimationRef.current);
      zoomAnimationRef.current = undefined;
    }
    setSize({ width: 0, height: 0 });
    setScale(1);
    setFitMode(true);
    setChannel("RGB");
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
      setSize({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.src = url;
    return () => {
      imageRef.current = undefined;
    };
  }, [url]);

  useEffect(
    () => () => {
      if (zoomAnimationRef.current !== undefined)
        cancelAnimationFrame(zoomAnimationRef.current);
    },
    [],
  );

  useEffect(() => {
    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (!image || !canvas || !size.width || !size.height) return;
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.clearRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0);
    if (channel === "RGB") return;
    const pixels = context.getImageData(0, 0, size.width, size.height);
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      const red = pixels.data[offset];
      const green = pixels.data[offset + 1];
      const blue = pixels.data[offset + 2];
      const alpha = pixels.data[offset + 3];
      pixels.data[offset] = channel === "R" ? red : channel === "A" ? alpha : 0;
      pixels.data[offset + 1] =
        channel === "G" ? green : channel === "A" ? alpha : 0;
      pixels.data[offset + 2] =
        channel === "B" ? blue : channel === "A" ? alpha : 0;
      if (channel === "A") pixels.data[offset + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
  }, [channel, size]);

  const fitScale =
    size.width && size.height && availableSize.width && availableSize.height
      ? Math.min(
          1,
          availableSize.width / size.width,
          availableSize.height / size.height,
        )
      : 1;
  const actualScale = fitMode ? fitScale : scale;
  currentScaleRef.current = actualScale;
  const animateActualScaleBy = (amount: number) => {
    const current = currentScaleRef.current;
    const pendingDirection = Math.sign(targetScaleRef.current - current);
    const requestedDirection = Math.sign(amount);
    // Reversing a damped zoom must take effect from the currently rendered
    // scale. Continuing from the old target makes the image briefly travel in
    // the wrong direction and looks like a centre-point jump.
    const startingScale =
      zoomAnimationRef.current === undefined ||
      (pendingDirection !== 0 && pendingDirection !== requestedDirection)
        ? current
        : targetScaleRef.current;
    targetScaleRef.current = Math.max(
      0.05,
      Math.min(4, startingScale + amount),
    );
    if (zoomAnimationRef.current === undefined)
      setScale(currentScaleRef.current);
    setFitMode(false);
    if (zoomAnimationRef.current !== undefined) return;
    const animate = () => {
      const current = currentScaleRef.current;
      const target = targetScaleRef.current;
      const next = current + (target - current) * 0.16;
      const finished = Math.abs(target - next) < 0.0005;
      const settled = finished ? target : next;
      currentScaleRef.current = settled;
      setScale(settled);
      if (finished) {
        zoomAnimationRef.current = undefined;
        return;
      }
      zoomAnimationRef.current = requestAnimationFrame(animate);
    };
    zoomAnimationRef.current = requestAnimationFrame(animate);
  };
  const resetZoom = () => {
    if (zoomAnimationRef.current !== undefined)
      cancelAnimationFrame(zoomAnimationRef.current);
    zoomAnimationRef.current = undefined;
    targetScaleRef.current = fitScale;
    currentScaleRef.current = fitScale;
    setScale(fitScale);
    setFitMode(true);
  };
  return (
    <section className="image-preview">
      <header className="media-preview-toolbar">
        <div className="image-channel-picker" aria-label="图像通道">
          {channels.map((item) => (
            <button
              className={item === channel ? "active" : undefined}
              key={item}
              onClick={() => setChannel(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </div>
        <span>
          {size.width && size.height ? `${size.width} × ${size.height}` : name}
        </span>
        <button
          aria-label="适应窗口"
          onClick={resetZoom}
          title="适应窗口"
          type="button"
        >
          <i
            aria-hidden="true"
            className="fa-solid fa-up-right-and-down-left-from-center"
          />
        </button>
        <button
          aria-label="缩小"
          disabled={actualScale <= 0.05}
          onClick={() => animateActualScaleBy(-0.1)}
          title="缩小"
          type="button"
        >
          <i aria-hidden="true" className="fa-solid fa-minus" />
        </button>
        <button
          className="zoom-value"
          onClick={resetZoom}
          title="适应窗口"
          type="button"
        >
          {Math.round(actualScale * 100)}%
        </button>
        <button
          aria-label="放大"
          disabled={actualScale >= 4}
          onClick={() => animateActualScaleBy(0.1)}
          title="放大"
          type="button"
        >
          <i aria-hidden="true" className="fa-solid fa-plus" />
        </button>
      </header>
      <MediaInfo
        items={[
          { label: en ? "Format" : "格式", value: mediaFormat(name) },
          {
            label: en ? "Dimensions" : "尺寸",
            value: size.width ? `${size.width} × ${size.height} px` : "—",
          },
          {
            label: en ? "Aspect" : "宽高比",
            value: aspectRatio(size.width, size.height),
          },
          { label: en ? "Size" : "大小", value: formatBytes(byteSize) },
          {
            label: en ? "Channels" : "通道",
            value: channels.includes("A") ? "RGB + Alpha" : "RGB",
          },
        ]}
      />
      <div
        className="image-preview-stage"
        onWheel={(event) => {
          event.preventDefault();
          const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
          animateActualScaleBy(-delta * 0.00035);
        }}
        ref={stageRef}
      >
        <canvas
          aria-label={`${name} 图片预览`}
          ref={canvasRef}
          style={{
            marginLeft: size.width ? `${-size.width / 2}px` : undefined,
            marginTop: size.height ? `${-size.height / 2}px` : undefined,
            transform: `scale(${actualScale})`,
          }}
        />
      </div>
    </section>
  );
}

function AudioPreview({
  byteSize,
  name,
  url,
}: {
  byteSize?: number;
  name: string;
  url: string;
}) {
  const { settings } = useSettings();
  const en = settings.locale === "en-US";
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const seekBy = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(
      0,
      Math.min(audio.duration || 0, audio.currentTime + seconds),
    );
  };
  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) await audio.play();
    else audio.pause();
  };
  return (
    <section className="audio-preview">
      <audio
        onDurationChange={(event) =>
          setDuration(event.currentTarget.duration || 0)
        }
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onTimeUpdate={(event) =>
          setCurrentTime(event.currentTarget.currentTime)
        }
        preload="metadata"
        ref={audioRef}
        src={url}
      />
      <div className="audio-artwork">
        <i aria-hidden="true" className="fa-solid fa-music" />
      </div>
      <strong>{name}</strong>
      <MediaInfo
        items={[
          { label: en ? "Format" : "格式", value: mediaFormat(name) },
          {
            label: en ? "Duration" : "时长",
            value: duration ? formatTime(duration) : "—",
          },
          { label: en ? "Size" : "大小", value: formatBytes(byteSize) },
        ]}
      />
      <div className="audio-controls">
        <button
          aria-label={en ? "Back 5 seconds" : "后退 5 秒"}
          className="audio-skip"
          onClick={() => seekBy(-5)}
          type="button"
        >
          <i aria-hidden="true" className="fa-solid fa-backward-step" />
        </button>
        <button
          aria-label={playing ? "暂停" : "播放"}
          className="audio-play"
          onClick={() => void togglePlayback()}
          type="button"
        >
          <i
            aria-hidden="true"
            className={`fa-solid fa-${playing ? "pause" : "play"}`}
          />
        </button>
        <button
          aria-label={en ? "Forward 5 seconds" : "前进 5 秒"}
          className="audio-skip"
          onClick={() => seekBy(5)}
          type="button"
        >
          <i aria-hidden="true" className="fa-solid fa-forward-step" />
        </button>
      </div>
      <div className="audio-seek">
        <span>{formatTime(currentTime)}</span>
        <input
          aria-label="播放进度"
          max={duration || 0}
          min={0}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (audioRef.current) audioRef.current.currentTime = value;
            setCurrentTime(value);
          }}
          step={0.01}
          type="range"
          value={Math.min(currentTime, duration || 0)}
        />
        <span>{formatTime(duration)}</span>
      </div>
    </section>
  );
}

function VideoPreview({
  byteSize,
  codec,
  name,
  url,
}: {
  byteSize?: number;
  codec?: string;
  name: string;
  url: string;
}) {
  const { settings } = useSettings();
  const en = settings.locale === "en-US";
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const seekBy = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(
      0,
      Math.min(video.duration || 0, video.currentTime + seconds),
    );
  };
  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) await video.play();
    else video.pause();
  };
  return (
    <section className="video-preview">
      <div className="video-stage">
        <video
          onClick={() => void togglePlayback()}
          onDurationChange={(event) =>
            setDuration(event.currentTarget.duration || 0)
          }
          onEnded={() => setPlaying(false)}
          onPause={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
          onLoadedMetadata={(event) =>
            setDimensions({
              height: event.currentTarget.videoHeight,
              width: event.currentTarget.videoWidth,
            })
          }
          onTimeUpdate={(event) =>
            setCurrentTime(event.currentTarget.currentTime)
          }
          preload="metadata"
          ref={videoRef}
          src={url}
        />
      </div>
      <MediaInfo
        items={[
          { label: en ? "Format" : "格式", value: mediaFormat(name) },
          {
            label: en ? "Codec" : "编码",
            value: codec ?? (en ? "Unknown" : "未知"),
          },
          {
            label: en ? "Dimensions" : "尺寸",
            value: dimensions.width
              ? `${dimensions.width} × ${dimensions.height} px`
              : "—",
          },
          {
            label: en ? "Aspect" : "宽高比",
            value: aspectRatio(dimensions.width, dimensions.height),
          },
          {
            label: en ? "Duration" : "时长",
            value: duration ? formatTime(duration) : "—",
          },
          {
            label: en ? "Average bitrate" : "平均码率",
            value: formatBitrate(byteSize, duration),
          },
          { label: en ? "Size" : "大小", value: formatBytes(byteSize) },
        ]}
      />
      <div className="video-control-bar">
        <strong>{name}</strong>
        <button
          aria-label="后退 10 秒"
          onClick={() => seekBy(-10)}
          type="button"
        >
          <i aria-hidden="true" className="fa-solid fa-backward" />
        </button>
        <button
          aria-label={playing ? "暂停" : "播放"}
          onClick={() => void togglePlayback()}
          type="button"
        >
          <i
            aria-hidden="true"
            className={`fa-solid fa-${playing ? "pause" : "play"}`}
          />
        </button>
        <button
          aria-label="前进 10 秒"
          onClick={() => seekBy(10)}
          type="button"
        >
          <i aria-hidden="true" className="fa-solid fa-forward" />
        </button>
        <span>{formatTime(currentTime)}</span>
        <input
          aria-label="播放进度"
          max={duration || 0}
          min={0}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (videoRef.current) videoRef.current.currentTime = value;
            setCurrentTime(value);
          }}
          step={0.01}
          type="range"
          value={Math.min(currentTime, duration || 0)}
        />
        <span>{formatTime(duration)}</span>
      </div>
    </section>
  );
}

export function MediaPreview({
  byteSize,
  codec,
  kind,
  name,
  url,
}: {
  byteSize?: number;
  codec?: string;
  kind: PreviewKind;
  name: string;
  url: string;
}) {
  if (kind === "image")
    return <ImagePreview byteSize={byteSize} name={name} url={url} />;
  if (kind === "audio")
    return <AudioPreview byteSize={byteSize} name={name} url={url} />;
  if (kind === "video")
    return (
      <VideoPreview byteSize={byteSize} codec={codec} name={name} url={url} />
    );
  return (
    <iframe className="pdf-preview" src={url} title={`${name} PDF 预览`} />
  );
}
