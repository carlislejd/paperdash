import { useEffect, useRef, useState } from "react";
import { downloadImage } from "./image-export";

export interface ImageCapture {
  filename: string;
  title: string;
  text: string;
  url: string;
  render: () => Promise<Blob>;
}

/** capture() freezes both image contents and share metadata before async rendering. */
export function useImageActions({
  capture,
  getLink,
  linkLabel,
  imageLabel,
}: {
  capture: () => ImageCapture;
  getLink: () => string;
  linkLabel: string;
  imageLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [manualLink, setManualLink] = useState<string | null>(null);
  const [readyFile, setReadyFile] = useState<{
    file: File;
    title: string;
    text: string;
    url: string;
  } | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);
  const reset = () => {
    epoch.current++;
    inFlight.current = false;
    setBusy(false);
    setMessage("");
    setManualLink(null);
    setReadyFile(null);
  };
  async function copyLink() {
    const url = getLink(),
      version = epoch.current;
    try {
      await navigator.clipboard.writeText(url);
      if (mounted.current && version === epoch.current) {
        setMessage(
          `${linkLabel[0].toUpperCase()}${linkLabel.slice(1)} link copied.`,
        );
        setManualLink(null);
      }
    } catch {
      if (mounted.current && version === epoch.current) {
        setManualLink(url);
        setMessage(`Copy this ${linkLabel} link.`);
      }
    }
  }
  async function download() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    const version = epoch.current;
    try {
      const frozen = capture(),
        blob = await frozen.render();
      if (!mounted.current || version !== epoch.current) return;
      downloadImage(blob, frozen.filename);
      setMessage("PNG downloaded.");
    } catch (cause) {
      if (mounted.current && version === epoch.current)
        setMessage(
          cause instanceof Error
            ? cause.message
            : "Image export failed. Try again.",
        );
    } finally {
      if (version === epoch.current) {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }
  async function share() {
    if (inFlight.current) return;
    if (!navigator.share || !navigator.canShare) {
      await copyLink();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    const version = epoch.current;
    try {
      const frozen = capture();
      const ready = readyFile ?? {
        title: frozen.title,
        text: frozen.text,
        url: frozen.url,
        file: new File([await frozen.render()], frozen.filename, {
          type: "image/png",
        }),
      };
      if (!mounted.current || version !== epoch.current) return;
      if (!navigator.canShare({ files: [ready.file] })) {
        await copyLink();
        return;
      }
      setReadyFile(ready);
      await navigator.share({
        files: [ready.file],
        title: ready.title,
        text: ready.text,
        url: ready.url,
      });
      if (mounted.current && version === epoch.current) {
        setMessage(`${imageLabel} shared.`);
        setReadyFile(null);
      }
    } catch (cause) {
      if (!mounted.current || version !== epoch.current) return;
      if (cause instanceof DOMException && cause.name === "AbortError") {
        setMessage("Share cancelled.");
        setReadyFile(null);
      } else if (
        cause instanceof DOMException &&
        cause.name === "NotAllowedError"
      )
        setMessage("Image ready. Tap Share again, or copy the link.");
      else
        setMessage(
          cause instanceof Error
            ? cause.message
            : "Sharing failed. Download the PNG or copy the link.",
        );
    } finally {
      if (version === epoch.current) {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }
  return {
    busy,
    message,
    manualLink,
    readyFile,
    copyLink,
    download,
    share,
    reset,
  };
}
