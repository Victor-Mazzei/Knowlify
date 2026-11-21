import { useEffect, useRef, useState } from "react";

/** Page-wide file drop, active only while files are dragged over the window. */
export function useFileDrop(onFile: (file: File) => void, enabled = true) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const fileHandler = useRef(onFile);
  fileHandler.current = onFile;

  useEffect(() => {
    if (!enabled) return;
    const acceptsFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

    const onDragEnter = (event: DragEvent) => {
      if (!acceptsFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!acceptsFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = () => {
      if (depth.current === 0) return;
      depth.current -= 1;
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!acceptsFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = event.dataTransfer?.files[0];
      if (file) fileHandler.current(file);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      depth.current = 0;
      setDragging(false);
    };
  }, [enabled]);

  return dragging;
}
