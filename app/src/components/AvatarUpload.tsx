"use client";

import { useState, useRef, useCallback } from "react";
import ReactCrop, { type Crop, type PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

interface AvatarUploadProps {
  onUpload: (dataUrl: string) => void;
  currentAvatar?: string;
}

export function AvatarUpload({ onUpload, currentAvatar }: AvatarUploadProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<Crop>({
    unit: "%",
    width: 80,
    height: 80,
    x: 10,
    y: 10,
  });
  const imgRef = useRef<HTMLImageElement | null>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSrc(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleCropComplete = useCallback(
    (pixelCrop: PixelCrop) => {
      if (!imgRef.current || !pixelCrop.width || !pixelCrop.height) return;

      const canvas = document.createElement("canvas");
      const size = 200;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(
        imgRef.current,
        pixelCrop.x,
        pixelCrop.y,
        pixelCrop.width,
        pixelCrop.height,
        0,
        0,
        size,
        size
      );

      onUpload(canvas.toDataURL("image/jpeg", 0.9));
    },
    [onUpload]
  );

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative">
        <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-2 border-[var(--border)] bg-[var(--card)]">
          {currentAvatar ? (
            <img src={currentAvatar} alt="Avatar" className="h-full w-full object-cover" />
          ) : (
            <svg viewBox="0 0 24 24" className="h-10 w-10 text-[var(--muted)]" fill="currentColor">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
            </svg>
          )}
        </div>
        <label className="absolute -bottom-1 -right-1 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-[var(--accent)] text-white transition-opacity hover:opacity-80">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          <input type="file" accept="image/*" className="hidden" onChange={handleFileSelect} />
        </label>
      </div>

      {src && (
        <div className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <ReactCrop
            crop={crop}
            onChange={(c) => setCrop(c)}
            onComplete={handleCropComplete}
            aspect={1}
            circularCrop
          >
            <img
              ref={imgRef}
              src={src}
              alt="Upload"
              className="max-h-64 w-full object-contain"
            />
          </ReactCrop>
          <button
            onClick={() => setSrc(null)}
            className="mt-3 w-full rounded-full bg-[var(--accent)] py-2 text-sm font-medium text-white"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
