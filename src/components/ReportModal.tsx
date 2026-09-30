'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  Construction,
  Droplets,
  Trash2,
  Lightbulb,
  Waves,
  HelpCircle,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Send,
  Zap,
  Mic,
  MicOff,
  Globe,
  TrendingUp
} from 'lucide-react';
import { LocationPicker, LocationData } from './LocationPicker';
import { MediaUpload } from './MediaUpload';
import { Category, ExifMetadata, ReportIntent, SubmissionResponse, LocationFix } from '@/lib/types';
import { SupportedLanguage, SUPPORTED_LANGUAGES, TRANSLATIONS } from '@/lib/languages';

interface ReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  categories: Category[];
  onReportSubmitted: (result: SubmissionResponse) => void;
  initialLocation?: LocationFix | null;
}

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  ROAD_POTHOLE: Construction,
  DRAINAGE_OVERFLOW: Droplets,
  GARBAGE_DUMP: Trash2,
  STREETLIGHT_OUTAGE: Lightbulb,
  WATER_SUPPLY_BURST: Waves,
  OTHERS: HelpCircle,
};

// Default coordinate is overridden immediately by live GPS; kept neutral (India centre)
const DEFAULT_LAT = 20.5937;
const DEFAULT_LNG = 78.9629;

export const ReportModal: React.FC<ReportModalProps> = ({
  isOpen,
  onClose,
  categories,
  onReportSubmitted,
  initialLocation = null,
}) => {
  const [lang, setLang] = useState<SupportedLanguage>('en');
  const t = TRANSLATIONS[lang];
  const activeLangMeta = SUPPORTED_LANGUAGES.find((l) => l.code === lang) || SUPPORTED_LANGUAGES[0];

  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(categories[0]?.id || '');
  // Complaint by default; development requests are opt-in and submit without
  // requiring a photo (there is often nothing to photograph yet).
  const [intent, setIntent] = useState<ReportIntent>('complaint');
  const [location, setLocation] = useState<LocationData>({
    latitude: DEFAULT_LAT,
    longitude: DEFAULT_LNG,
    accuracyMeters: 10,
    isOnSite: true,
    source: null,
  });
  const [imageUrl, setImageUrl] = useState<string>('');
  const [exif, setExif] = useState<ExifMetadata>({ hasGps: false });
  const [notes, setNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submissionResult, setSubmissionResult] = useState<SubmissionResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Voice-to-text (Web Speech API) in the citizen's chosen language
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [liveTranscript, setLiveTranscript] = useState<string>('');
  const recognitionRef = useRef<any>(null);

  // Voice note: records an audio clip while the citizen speaks, so the report
  // ships with both a playable clip AND its transcription (fed to ML analysis).
  const [voiceNote, setVoiceNote] = useState<{ audioUrl: string; transcript: string } | null>(null);
  const [clipSeconds, setClipSeconds] = useState<number>(0);
  const [consentGiven, setConsentGiven] = useState<boolean>(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Stop any active recognition when the modal closes or unmounts
  useEffect(() => {
    if (!isOpen) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      if (recognitionRef.current) recognitionRef.current.stop();
      setIsRecording(false);
      setLiveTranscript('');
      setClipSeconds(0);
    }
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      if (recognitionRef.current) recognitionRef.current.stop();
    };
  }, []);

  // Recorder timer
  useEffect(() => {
    if (!isRecording) return;
    const startTime = Date.now();
    const id = setInterval(() => setClipSeconds(Math.floor((Date.now() - startTime) / 1000)), 1000);
    return () => clearInterval(id);
  }, [isRecording]);

  if (!isOpen) return null;

  // Starts / stops voice recognition + audio clip recording. Recognised text
  // lands in the landmark box in the citizen's language (hi-IN, ta-IN, te-IN…)
  // and a playable audio clip is captured alongside it.
  const toggleVoiceInput = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      } else {
        recognitionRef.current?.stop();
      }
      return;
    }

    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      setErrorMessage('Voice input is not supported in this browser. Please type your report.');
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = activeLangMeta.speechCode;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      let interim = '';
      let finalChunk = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalChunk += transcript;
        } else {
          interim += transcript;
        }
      }

      if (finalChunk) {
        setNotes((prev) => {
          const trimmedPrev = prev.trim();
          return trimmedPrev ? `${trimmedPrev}${trimmedPrev.endsWith('.') || trimmedPrev.endsWith('।') ? ' ' : '. '}${finalChunk.trim()}` : finalChunk.trim();
        });
      }
      setLiveTranscript(interim);
    };

    recognition.onerror = (event: any) => {
      // Browser aborted / no speech: quietly reset the button
      if (event?.error === 'no-speech') {
        setIsRecording(false);
        setLiveTranscript('');
      } else if (event?.error === 'not-allowed') {
        setErrorMessage('Microphone permission denied. Please allow the mic to use voice reporting.');
        setIsRecording(false);
        setLiveTranscript('');
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }
    };

    recognition.onend = () => {
      setIsRecording(false);
      setLiveTranscript('');
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
    };

    recognitionRef.current = recognition;

    // Record the audio clip alongside the live transcription — no server round
    // trip, fully on-device (the clip is uploaded with the report as evidence).
    try {
      if (navigator.mediaDevices?.getUserMedia) {
        audioChunksRef.current = [];
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mr = new MediaRecorder(stream);
        mr.ondataavailable = (e: BlobEvent) => {
          if (e.data.size > 0) audioChunksRef.current.push(e.data);
        };
        mr.onstop = () => {
          const type = mr.mimeType || 'audio/webm';
          const blob = new Blob(audioChunksRef.current, { type });
          const reader = new FileReader();
          reader.onload = async () => {
            const audioUrl = String(reader.result || '');
            setVoiceNote((prev) => ({
              audioUrl,
              transcript: prev?.transcript || notes.trim(),
            }));

            // Let Gemini transcribe the clip and translate it for the department
            // queue. The browser-side transcript stays as the fallback.
            try {
              const res = await fetch('/api/voice/transcribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  audioData: audioUrl,
                  languageHint: activeLangMeta.name,
                }),
              });
              if (!res.ok) return;
              const data = await res.json();
              if (data?.engine !== 'gemini' || !data?.transcript) return;

              const parts = [data.transcript];
              if (data.englishTranscript && data.englishTranscript !== data.transcript) {
                parts.push(`English: ${data.englishTranscript}`);
              }
              const combined = parts.join('\n');
              setVoiceNote((prev) => (prev ? { ...prev, transcript: combined } : prev));
              setNotes((prev) => (prev.trim() ? prev : data.transcript));
            } catch {
              // Transcription is best-effort — keep the local transcript.
            }
          };
          reader.readAsDataURL(blob);
          stream.getTracks().forEach((t) => t.stop());
        };
        mr.start();
        mediaRecorderRef.current = mr;
      }
    } catch {
      // Mic unavailable for recording — live transcription still works.
    }

    recognition.start();
    setIsRecording(true);
    setErrorMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedCategoryId) {
      setErrorMessage('Please select an issue category.');
      return;
    }

    if (!imageUrl && intent === 'complaint') {
      setErrorMessage('Please capture or select an image evidence.');
      return;
    }

    if (!location.source) {
      setErrorMessage(
        'Location not confirmed yet. Allow GPS, search your address, or tap the map to drop a pin — this keeps the civic data accurate.'
      );
      return;
    }

    if (!consentGiven) {
      setErrorMessage('Please confirm the data consent notice before submitting your report.');
      return;
    }

    // Commit any pending spoken text before submitting
    if (recognitionRef.current) recognitionRef.current.stop();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    setLiveTranscript('');

    setSubmitting(true);
    setErrorMessage(null);

    try {
      const payload = {
        categoryId: selectedCategoryId,
        intent,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracyMeters: location.accuracyMeters,
        isOnSite: location.isOnSite,
        imageUrl,
        citizenNotes: notes,
        transcript: voiceNote?.transcript || undefined,
        exif,
        locationDetails: location.locationDetails,
      };

      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to submit report.');
      }

      setSubmissionResult(data);
      onReportSubmitted(data);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Error submitting report');
    } finally {
      setSubmitting(false);
    }
  };

  const resetAndClose = () => {
    if (recognitionRef.current) recognitionRef.current.stop();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    setIsRecording(false);
    setLiveTranscript('');
    setVoiceNote(null);
    setClipSeconds(0);
    setSubmissionResult(null);
    setErrorMessage(null);
    setImageUrl('');
    setNotes('');
    setIntent('complaint');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-950/60 backdrop-blur-md transition-all">
      <div className="relative w-full max-w-2xl border rounded-t-[2.5rem] sm:rounded-3xl shadow-2xl overflow-hidden max-h-[92dvh] sm:max-h-[90vh] flex flex-col animate-in slide-in-from-bottom duration-300 transition-colors
                      bg-white border-slate-200 text-slate-900 
                      dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100">
        
        {/* Mobile Pull Handle */}
        <div className="sm:hidden pt-3.5 pb-1 flex justify-center">
          <div className="w-12 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full" />
        </div>

        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800">
          <div>
            <h3 className="text-base sm:text-xl font-bold">{t.reportHazardTitle}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              High-accuracy verification with PostGIS spatial deduplication
            </p>
          </div>
          <button
            onClick={resetAndClose}
            className="p-2 rounded-xl transition hover:bg-slate-100 text-slate-400 hover:text-slate-700 dark:hover:bg-slate-800 dark:text-slate-400 dark:hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="p-6 overflow-y-auto space-y-6 pb-28 sm:pb-6">
          {submissionResult ? (
            /* Success Feedback Card */
            <div className="space-y-6 py-4 text-center">
              <div className="inline-flex p-4 rounded-3xl bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20 shadow-sm">
                <CheckCircle2 className="w-10 h-10" />
              </div>
              <div>
                <h4 className="text-xl sm:text-2xl font-bold">
                  {submissionResult.isDuplicate
                    ? 'Spatial Deduplication Triggered!'
                    : 'Incident Logged & Dispatched!'}
                </h4>
                <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 max-w-md mx-auto mt-1.5 leading-relaxed">
                  {submissionResult.isDuplicate ? t.duplicateNotice : t.novelNotice}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-2">
                <div className="p-4 rounded-2xl border bg-slate-50 border-slate-200/80 dark:bg-slate-950 dark:border-slate-800">
                  <span className="text-xs text-slate-500 dark:text-slate-400 block uppercase font-bold tracking-wider">{t.priorityScore}</span>
                  <span className="text-2xl font-extrabold text-amber-600 dark:text-amber-400 font-mono mt-1 block">
                    {submissionResult.priorityScore} pts
                  </span>
                </div>
                <div className="p-4 rounded-2xl border bg-slate-50 border-slate-200/80 dark:bg-slate-950 dark:border-slate-800">
                  <span className="text-xs text-slate-500 dark:text-slate-400 block uppercase font-bold tracking-wider">{t.reportsCount}</span>
                  <span className="text-2xl font-extrabold text-emerald-600 dark:text-emerald-400 font-mono mt-1 block">
                    {submissionResult.reportCount}
                  </span>
                </div>
              </div>

              {submissionResult.mlAnalysis && (
                <div className="p-4 rounded-2xl border text-left text-xs space-y-2 bg-slate-50 border-slate-200/80 dark:bg-slate-950/90 dark:border-slate-800">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-700 dark:text-slate-300 flex items-center">
                      <Zap className="w-4 h-4 text-amber-500 mr-1.5" />
                      {t.visionClassifier}
                    </span>
                    <span className="font-mono text-emerald-600 dark:text-emerald-400 font-bold">
                      {Math.round(submissionResult.mlAnalysis.categoryConfidence * 100)}% Confidence
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
                    <span>{t.severity}:</span>
                    <strong className="text-slate-900 dark:text-slate-100 font-bold">{submissionResult.mlAnalysis.estimatedSeverity} / 5.0</strong>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={resetAndClose}
                className="w-full py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-md shadow-emerald-600/20 transition"
              >
                {t.returnToMap}
              </button>
            </div>
          ) : (
            <form id="report-form" onSubmit={handleSubmit} className="space-y-6">
              {errorMessage && (
                <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 dark:bg-rose-500/10 dark:border-rose-500/30 dark:text-rose-300 text-xs flex items-center space-x-2.5">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{errorMessage}</span>
                </div>
              )}

              {/* 0. Intent: report an existing problem vs request new development */}
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setIntent('complaint')}
                    className={`flex items-center justify-center space-x-2 p-3 rounded-2xl border text-xs font-bold transition-all ${
                      intent === 'complaint'
                        ? 'bg-rose-50 border-rose-500 text-rose-900 shadow-sm dark:bg-rose-500/15 dark:border-rose-500 dark:text-white'
                        : 'bg-slate-50/70 border-slate-200 text-slate-600 hover:bg-slate-100 dark:bg-slate-950/60 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-950'
                    }`}
                  >
                    <AlertTriangle className={`w-4 h-4 ${intent === 'complaint' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400'}`} />
                    <span>Report a problem</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIntent('development_request')}
                    className={`flex items-center justify-center space-x-2 p-3 rounded-2xl border text-xs font-bold transition-all ${
                      intent === 'development_request'
                        ? 'bg-amber-50 border-amber-500 text-amber-900 shadow-sm dark:bg-amber-500/15 dark:border-amber-500 dark:text-white'
                        : 'bg-slate-50/70 border-slate-200 text-slate-600 hover:bg-slate-100 dark:bg-slate-950/60 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-950'
                    }`}
                  >
                    <TrendingUp className={`w-4 h-4 ${intent === 'development_request' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`} />
                    <span>Request development</span>
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  {intent === 'complaint'
                    ? 'Something is broken today — report it with photo evidence.'
                    : 'Ask for something new — a road, water line, bus stop or streetlight. Photo optional; describe what is missing.'}
                </p>
              </div>

              {/* 1. Category Selection */}
              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  1. {t.stepCategory}
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {categories.map((cat) => {
                    const Icon = CATEGORY_ICONS[cat.code] || Construction;
                    const isSelected = selectedCategoryId === cat.id;

                    return (
                      <button
                        type="button"
                        key={cat.id}
                        onClick={() => setSelectedCategoryId(cat.id)}
                        className={`flex items-center space-x-3 p-3.5 rounded-2xl border text-left transition-all ${
                          isSelected
                            ? 'bg-emerald-50 border-emerald-500 text-emerald-900 shadow-sm dark:bg-emerald-500/15 dark:border-emerald-500 dark:text-white'
                            : 'bg-slate-50/70 border-slate-200 text-slate-600 hover:bg-slate-100 dark:bg-slate-950/60 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-950'
                        }`}
                      >
                        <Icon className={`w-5 h-5 flex-shrink-0 ${isSelected ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`} />
                        <div className="min-w-0">
                          <span className="text-xs font-bold block truncate">{cat.name}</span>
                          <span className="text-[10px] text-slate-400 block mt-0.5">{cat.defaultSlaHours}h SLA</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 2. Visual Evidence & EXIF */}
              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  2. {t.stepPhoto}
                  {intent === 'development_request' && (
                    <span className="ml-2 normal-case tracking-normal text-amber-600 dark:text-amber-400 font-semibold">
                      (optional for development requests)
                    </span>
                  )}
                </label>
                <MediaUpload
                  reportedLatitude={location.latitude}
                  reportedLongitude={location.longitude}
                  onImageReady={({ imageUrl: url, exif: meta }) => {
                    setImageUrl(url);
                    setExif(meta);
                  }}
                />
              </div>

              {/* 3. Location Verification */}
              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  3. {t.stepLocation}
                </label>
                <LocationPicker
                  lang={lang}
                  initialLocation={initialLocation}
                  onLocationResolved={(loc) => setLocation(loc)}
                />
              </div>

              {/* 4. Landmark / Additional Notes + Voice Input */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    4. {t.landmarkLabel}
                  </label>
                  <div className="flex items-center space-x-1.5">
                    <Globe className="w-3.5 h-3.5 text-slate-400" />
                    <select
                      value={lang}
                      onChange={(e) => setLang(e.target.value as SupportedLanguage)}
                      className="text-[11px] font-semibold px-2 py-1.5 rounded-lg border transition
                                 bg-white border-slate-200 text-slate-700
                                 dark:bg-slate-950 dark:border-slate-800 dark:text-slate-300 focus:outline-none focus:border-emerald-500"
                      aria-label="Report language"
                    >
                      {SUPPORTED_LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.nativeName}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="relative">
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={t.landmarkPlaceholder}
                    rows={3}
                    className="w-full rounded-2xl pr-12 pl-4 py-3 text-xs border transition-colors resize-none
                               bg-slate-50 border-slate-200 text-slate-800 placeholder-slate-400 focus:outline-none focus:border-emerald-500
                               dark:bg-slate-950 dark:border-slate-800 dark:text-slate-200 dark:placeholder-slate-500"
                  />
                  {/* Voice mic pinned to the right edge of the text box */}
                  <button
                    type="button"
                    onClick={toggleVoiceInput}
                    title={t.micTooltip}
                    aria-label={isRecording ? t.micListening : t.micTooltip}
                    className={`absolute right-2 top-2 p-2.5 rounded-xl transition-all ${
                      isRecording
                        ? 'bg-rose-500 text-white shadow-lg shadow-rose-500/30 animate-pulse'
                        : 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30'
                    }`}
                  >
                    {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  </button>
                </div>

                {isRecording && (
                  <p className="text-[11px] text-rose-600 dark:text-rose-400 flex items-center space-x-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping" />
                    <span>
                      {t.micListening} — {activeLangMeta.speechCode} · {clipSeconds}s
                      {liveTranscript && <span className="text-slate-500 dark:text-slate-400"> · “{liveTranscript}”</span>}
                    </span>
                  </p>
                )}

                {voiceNote && (
                  <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center space-x-1.5">
                        <Mic className="w-3.5 h-3.5" />
                        <span>Voice note ready — saved as a transcript only; the recording is discarded</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setVoiceNote(null)}
                        aria-label="Remove voice note"
                        className="text-[10px] font-bold px-2 py-1 rounded-lg text-slate-400 hover:text-rose-500"
                      >
                        Remove
                      </button>
                    </div>
                    {voiceNote.audioUrl && (
                      <audio controls src={voiceNote.audioUrl} className="w-full h-9 mt-2" preload="metadata" />
                    )}
                    {voiceNote.transcript && (
                      <p className="mt-1.5 text-[11px] text-slate-600 dark:text-slate-300 italic">“{voiceNote.transcript}”</p>
                    )}
                  </div>
                )}
              </div>
            </form>
          )}
        </div>

        {/* Sticky Action Bar */}
        {!submissionResult && (
          <div className="p-4 sm:p-6 border-t border-slate-100 dark:border-slate-800 bg-white/95 dark:bg-slate-950/95 backdrop-blur-xl space-y-3">
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={consentGiven}
                onChange={(e) => setConsentGiven(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 shrink-0"
              />
              <span className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                I consent to CivicResolve storing my report, location, photo and voice note for resolving this
                grievance, and to processing them with Google Gemini to classify the issue. Aggregated views are
                anonymous. See <span className="font-semibold">PRIVACY.md</span>.
              </span>
            </label>
            <button
              type="submit"
              form="report-form"
              disabled={submitting}
              className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-lg shadow-emerald-600/25 transition active:scale-95 disabled:opacity-50 flex items-center justify-center space-x-2"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t.verifying}</span>
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  <span>{t.submitVerify}</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};