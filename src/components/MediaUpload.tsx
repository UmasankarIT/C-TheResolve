'use client';

import React, { useState, useRef } from 'react';
import exifr from 'exifr';
import { 
  Camera, 
  UploadCloud, 
  FileCheck,
  Loader2
} from 'lucide-react';
import { ExifMetadata } from '@/lib/types';
import { calculateGeodesicDistanceMeters } from '@/lib/spatial';

interface MediaUploadProps {
  reportedLatitude: number;
  reportedLongitude: number;
  onImageReady: (data: { imageUrl: string; exif: ExifMetadata }) => void;
}

export const MediaUpload: React.FC<MediaUploadProps> = ({
  reportedLatitude,
  reportedLongitude,
  onImageReady,
}) => {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [compressing, setCompressing] = useState<boolean>(false);
  const [exifInfo, setExifInfo] = useState<ExifMetadata | null>(null);
  const [compressionRatio, setCompressionRatio] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const compressImage = async (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();

      reader.onload = (e) => {
        img.src = e.target?.result as string;
      };

      img.onload = () => {
        const MAX_WIDTH = 1280;
        const MAX_HEIGHT = 1280;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(img.src);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        const webpDataUrl = canvas.toDataURL('image/webp', 0.82);
        resolve(webpDataUrl);
      };

      reader.onerror = (error) => reject(error);
      reader.readAsDataURL(file);
    });
  };

  const processFile = async (file: File) => {
    setCompressing(true);
    try {
      const originalSizeKb = Math.round(file.size / 1024);

      let exifData: ExifMetadata = { hasGps: false };
      try {
        const parsedExif = await exifr.parse(file, {
          gps: true,
          pick: ['DateTimeOriginal', 'latitude', 'longitude', 'Make', 'Model'],
        });

        if (parsedExif && parsedExif.latitude && parsedExif.longitude) {
          const delta = calculateGeodesicDistanceMeters(
            reportedLatitude,
            reportedLongitude,
            parsedExif.latitude,
            parsedExif.longitude
          );

          exifData = {
            hasGps: true,
            exifLatitude: parsedExif.latitude,
            exifLongitude: parsedExif.longitude,
            deltaMeters: Math.round(delta * 10) / 10,
            isSpoofed: delta > 300,
            capturedAt: parsedExif.DateTimeOriginal ? new Date(parsedExif.DateTimeOriginal).toISOString() : undefined,
            deviceMake: parsedExif.Make,
            deviceModel: parsedExif.Model,
          };
        }
      } catch (exifErr) {
        console.warn('No EXIF metadata:', exifErr);
      }

      const compressedUrl = await compressImage(file);
      const approxCompressedKb = Math.round((compressedUrl.length * 3) / 4 / 1024);

      setPreviewUrl(compressedUrl);
      setExifInfo(exifData);
      setCompressionRatio(`${originalSizeKb} KB → ${approxCompressedKb} KB`);

      onImageReady({
        imageUrl: compressedUrl,
        exif: exifData,
      });
    } catch (err) {
      console.error('Image processing failed:', err);
    } finally {
      setCompressing(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  return (
    <div className="p-5 rounded-3xl border transition-colors space-y-4
                    bg-slate-50 border-slate-200 text-slate-800 
                    dark:bg-slate-950/70 dark:border-slate-800 dark:text-slate-200">
      
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2.5">
          <div className="p-2 rounded-xl bg-teal-50 text-teal-600 dark:bg-teal-500/10 dark:text-teal-400">
            <Camera className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-xs sm:text-sm font-bold">Visual Evidence & EXIF</h4>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Client-side WebP compression & anti-spoof audit</p>
          </div>
        </div>

        {compressionRatio && (
          <span className="text-[10px] font-mono font-bold px-2.5 py-1 rounded-xl bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/20">
            {compressionRatio}
          </span>
        )}
      </div>

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/*"
        className="hidden"
      />
      <input
        type="file"
        ref={cameraInputRef}
        onChange={handleFileChange}
        accept="image/*"
        capture="environment"
        className="hidden"
      />

      {previewUrl ? (
        <div className="relative rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 aspect-video bg-slate-100 dark:bg-slate-950">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt="Incident Evidence"
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent flex items-end p-4">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-3.5 py-1.5 text-xs font-semibold rounded-xl bg-white/90 dark:bg-slate-900/90 text-slate-900 dark:text-white border border-slate-200 dark:border-slate-700 shadow-md transition"
            >
              Replace Photo
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            disabled={compressing}
            className="h-32 rounded-2xl border-2 border-dashed transition-all flex flex-col items-center justify-center p-4 text-center
                       border-slate-300 hover:border-emerald-500 bg-white hover:bg-slate-50 text-slate-700
                       dark:border-slate-800 dark:hover:border-emerald-500/50 dark:bg-slate-950/50 dark:hover:bg-slate-950 dark:text-slate-300"
          >
            {compressing ? (
              <Loader2 className="w-5 h-5 animate-spin text-emerald-600 dark:text-emerald-400" />
            ) : (
              <div className="flex flex-col items-center space-y-1.5">
                <Camera className="w-5 h-5" />
                <p className="text-xs font-bold">Take Photo</p>
              </div>
            )}
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={compressing}
            className="h-32 rounded-2xl border-2 border-dashed transition-all flex flex-col items-center justify-center p-4 text-center
                       border-slate-300 hover:border-emerald-500 bg-white hover:bg-slate-50 text-slate-700
                       dark:border-slate-800 dark:hover:border-emerald-500/50 dark:bg-slate-950/50 dark:hover:bg-slate-950 dark:text-slate-300"
          >
            {compressing ? (
              <Loader2 className="w-5 h-5 animate-spin text-emerald-600 dark:text-emerald-400" />
            ) : (
              <div className="flex flex-col items-center space-y-1.5">
                <UploadCloud className="w-5 h-5" />
                <p className="text-xs font-bold">Upload File</p>
              </div>
            )}
          </button>
        </div>
      )}

      {!previewUrl && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400 text-center">Auto-converted to compressed WebP</p>
      )}

      {/* EXIF Metadata Audit Box */}
      {exifInfo && (
        <div className="p-3.5 rounded-2xl border text-xs space-y-2 transition-colors
                        bg-white border-slate-200 
                        dark:bg-slate-900 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <span className="font-bold flex items-center text-slate-700 dark:text-slate-300">
              <FileCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mr-1.5" />
              EXIF Metadata Audit
            </span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
              exifInfo.isSpoofed
                ? 'bg-rose-50 text-rose-700 border border-rose-200 dark:bg-rose-500/20 dark:text-rose-300'
                : 'bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-300'
            }`}>
              {exifInfo.isSpoofed ? 'Location Mismatch (>300m)' : 'EXIF Geo-Locked'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-500 dark:text-slate-400 pt-1">
            <div>
              <span>Embedded GPS: </span>
              <strong className="text-slate-800 dark:text-slate-200 block mt-0.5">
                {exifInfo.hasGps ? `${exifInfo.exifLatitude?.toFixed(4)}, ${exifInfo.exifLongitude?.toFixed(4)}` : 'None in photo'}
              </strong>
            </div>
            <div>
              <span>Delta to Report: </span>
              <strong className={`block mt-0.5 ${exifInfo.isSpoofed ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {exifInfo.deltaMeters !== undefined ? `~${exifInfo.deltaMeters}m` : 'N/A'}
              </strong>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
