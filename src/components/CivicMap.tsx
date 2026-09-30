'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Issue, Category, LocationFix, GeocodeHit } from '@/lib/types';
import { searchPlaces } from '@/lib/places';
import { 
  ThumbsUp, 
  MapPin, 
  Crosshair, 
  X,
  Zap,
  ArrowRight,
  Search,
  Loader2
} from 'lucide-react';

// Default map focus: geographic centre of India (actual position is auto-fetched via GPS)
const DEFAULT_CENTER: [number, number] = [20.5937, 78.9629];

// Free, keyless OSM basemap — CARTO raster tiles now require an API key and show an
// "API key required" watermark without one. Dark mode is emulated with a CSS filter.
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DARK_TILE_FILTER = 'invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.9) saturate(0.85)';

interface CivicMapProps {
  issues: Issue[];
  categories: Category[];
  selectedCategory: string;
  onSelectCategory: (catId: string) => void;
  selectedStatus: string;
  onSelectStatus: (status: string) => void;
  onUpvote: (issueId: string) => void;
  onSelectIssue?: (issue: Issue) => void;
  selectedIssueId?: string | null;
  initialLocation?: LocationFix | null;
  locationStatus?: 'idle' | 'requesting' | 'granted' | 'denied' | 'unsupported';
}

export const CivicMap: React.FC<CivicMapProps> = ({
  issues,
  categories,
  selectedCategory,
  onSelectCategory,
  selectedStatus,
  onSelectStatus,
  onUpvote,
  onSelectIssue,
  selectedIssueId,
  initialLocation = null,
  locationStatus = 'idle',
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const tileLayerRef = useRef<any>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const markersRef = useRef<{ [key: string]: any }>({});
  const userMarkerRef = useRef<any>(null);
  const userCoordsRef = useRef<{ lat: number; lng: number } | null>(null);
  const [activeIssue, setActiveIssue] = useState<Issue | null>(null);
  const [upvotingId, setUpvotingId] = useState<string | null>(null);
  const [locating, setLocating] = useState<boolean>(false);
  const [gpsStatus, setGpsStatus] = useState<string>('Tap crosshair to locate you');
  const searchMarkerRef = useRef<any>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const [mapQuery, setMapQuery] = useState<string>('');
  const [mapResults, setMapResults] = useState<GeocodeHit[]>([]);
  const [mapSearching, setMapSearching] = useState<boolean>(false);
  const [mapSearchError, setMapSearchError] = useState<boolean>(false);
  const [mapShowResults, setMapShowResults] = useState<boolean>(false);
  const [mapReady, setMapReady] = useState<boolean>(false);

  // Locate the citizen with live GPS and move the radar marker to their real position.
  // The map is created at the neutral India-centre fallback, then flies to the citizen
  // once their coordinates resolve (works from any place in India).
  const locateUser = useCallback(({ animate = true }: { animate?: boolean } = {}) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsStatus('Geolocation not supported');
      return;
    }
    setLocating(true);
    setGpsStatus('Locating you…');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        userCoordsRef.current = { lat: latitude, lng: longitude };
        setGpsStatus(`Live · ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);

        const map = mapInstanceRef.current;
        if (map) {
          if (userMarkerRef.current) {
            userMarkerRef.current.setLatLng([latitude, longitude]);
          }
          if (animate) map.flyTo([latitude, longitude], 15, { duration: 1.2 });
        }
        setLocating(false);
      },
      () => {
        setLocating(false);
        setGpsStatus('Location unavailable — tap crosshair to retry');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
    );
  }, []);

  // Initialize Leaflet Map
  useEffect(() => {
    if (typeof window === 'undefined' || !mapContainerRef.current) return;

    let isMounted = true;

    import('leaflet').then((L) => {
      if (!isMounted || !mapContainerRef.current) return;

      if (!mapInstanceRef.current) {
        const isDark = document.documentElement.classList.contains('dark');

        const map = L.map(mapContainerRef.current, {
          center: DEFAULT_CENTER,
          zoom: 14,
          zoomControl: false,
        });

        const tileLayer = L.tileLayer(TILE_URL, {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | C - TheResolve',
          maxZoom: 19,
        }).addTo(map);

        tileLayerRef.current = tileLayer;

        // OSM has no native dark tiles; emulate dark mode with a CSS filter on the tile pane
        const tilePane = map.getPane('tilePane');
        if (tilePane) {
          tilePane.style.filter = isDark ? DARK_TILE_FILTER : '';
        }

        if (window.innerWidth >= 768) {
          L.control.zoom({ position: 'bottomright' }).addTo(map);
        }

        // Radar user GPS marker
        const userIcon = L.divIcon({
          className: 'custom-user-marker',
          html: `
            <div class="relative w-8 h-8 flex items-center justify-center">
              <div class="radar-circle"></div>
              <div class="w-4 h-4 bg-emerald-500 border-2 border-white rounded-full shadow-lg z-10"></div>
            </div>
          `,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });

        userMarkerRef.current = L.marker(DEFAULT_CENTER, { icon: userIcon })
          .addTo(map)
          .bindTooltip('Your Verified Location', { direction: 'top', offset: [0, -10] });

        // Hidden pin shown when the citizen searches for a place to view issues anywhere
        const searchIcon = L.divIcon({
          className: 'custom-searched-place-marker',
          html: `
            <div class="relative w-9 h-9">
              <div class="absolute inset-0 rounded-full bg-rose-500/30 animate-ping"></div>
              <div class="absolute inset-1 rounded-full bg-rose-500 border-2 border-white shadow-xl flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>
              </div>
            </div>
          `,
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        });
        searchMarkerRef.current = L.marker(DEFAULT_CENTER, { icon: searchIcon, interactive: false })
          .addTo(map)
          .setOpacity(0);

        mapInstanceRef.current = map;

        // Signal that Leaflet is ready so the centering-on-initialLocation
        // effect can re-fire. This matters when switching away from the map
        // tab and back: the component remounts, but initialLocation never
        // changes afterwards, so without this the map stays at the default
        // India-centre instead of returning to the citizen's position.
        if (isMounted) setMapReady(true);

        // Some engines hand Leaflet a stale container size (e.g. 0px) at mount
        // inside flex/viewport layouts; re-measure once the frame paints so the
        // tiles always render, and keep the map synced if the container resizes
        // (banner collapse after sign-in, viewport changes, rotation, etc.).
        window.requestAnimationFrame(() => {
          if (mapInstanceRef.current) mapInstanceRef.current.invalidateSize();
        });

        if (typeof ResizeObserver !== 'undefined' && mapContainerRef.current) {
          const ro = new ResizeObserver(() => {
            if (mapInstanceRef.current) mapInstanceRef.current.invalidateSize();
          });
          ro.observe(mapContainerRef.current);
          resizeObserverRef.current = ro;
        }

        // The app-level locator (page.tsx) owns the first-open permission prompt;
        // the map centres itself on the resulting fix via the initialLocation effect below.
      }
    });

    // Theme change listener — same keyless OSM tiles, just toggle the dark filter
    const handleThemeChange = (e: any) => {
      if (!mapInstanceRef.current) return;
      const isDark = e.detail === 'dark';
      const tilePane = mapInstanceRef.current.getPane('tilePane');
      if (tilePane) {
        tilePane.style.filter = isDark ? DARK_TILE_FILTER : '';
      }
    };

    window.addEventListener('themeChanged', handleThemeChange);

    return () => {
      isMounted = false;
      window.removeEventListener('themeChanged', handleThemeChange);
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [locateUser]);

  // Centre the map on the citizen's location once the app-level GPS fix arrives.
  // Also re-checks when the Leaflet instance first becomes ready, so returning
  // to the map tab restores the last known position instead of the default.
  useEffect(() => {
    if (typeof window === 'undefined' || !mapInstanceRef.current || !mapReady || !initialLocation) return;
    if (userMarkerRef.current) {
      userMarkerRef.current.setLatLng([initialLocation.latitude, initialLocation.longitude]);
    }
    if (searchMarkerRef.current) {
      searchMarkerRef.current.setOpacity(0);
    }
    mapInstanceRef.current.flyTo([initialLocation.latitude, initialLocation.longitude], 15, { duration: 1 });
    setGpsStatus(`Live · ${initialLocation.latitude.toFixed(4)}, ${initialLocation.longitude.toFixed(4)}`);
  }, [initialLocation, mapReady]);

  // Debounced place search — jump the camera to any location to view its issues
  useEffect(() => {
    const q = mapQuery.trim();
    if (q.length < 3) {
      setMapResults([]);
      setMapSearching(false);
      setMapShowResults(false);
      return;
    }
    setMapSearching(true);
    setMapSearchError(false);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const hits = await searchPlaces(q, controller.signal);
        setMapResults(hits);
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        setMapSearchError(true);
        setMapResults([]);
      } finally {
        if (!controller.signal.aborted) setMapSearching(false);
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mapQuery]);

  // Close the search dropdown when clicking anywhere outside it
  useEffect(() => {
    if (!mapShowResults) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setMapShowResults(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [mapShowResults]);

  const flyToPlace = (hit: GeocodeHit) => {
    const map = mapInstanceRef.current;
    if (map) {
      if (searchMarkerRef.current) {
        searchMarkerRef.current.setLatLng([hit.lat, hit.lon]);
        searchMarkerRef.current.setOpacity(1);
      }
      map.flyTo([hit.lat, hit.lon], 15, { duration: 1.2 });
    }
    setMapQuery(hit.label);
    setMapResults([]);
    setMapShowResults(false);
    setActiveIssue(null);
  };

  // Sync selected issue from prop. The map is kept mounted (hidden) across tab
  // switches, so before flying we must re-measure the just-unhidden container and
  // defend against NaN/leaflet animation errors — otherwise Leaflet throws an
  // unhandled exception that blanks the whole app.
  useEffect(() => {
    if (!selectedIssueId) return;
    if (typeof window === 'undefined') return;
    const match = issues.find((i) => i.id === selectedIssueId);
    if (!match) return;
    setActiveIssue(match);

    const map = mapInstanceRef.current;
    if (!map) return;
    const lat = Number(match.latitude);
    const lng = Number(match.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    try {
      map.invalidateSize();
    } catch (err) {
      console.error('Failed to re-measure map before flyTo:', err);
    }

    requestAnimationFrame(() => {
      const mapRef = mapInstanceRef.current;
      if (!mapRef) return;
      try {
        mapRef.flyTo([lat, lng], 16, { duration: 1.2 });
      } catch (err) {
        console.error('Failed to fly to selected issue:', err);
      }
    });
  }, [selectedIssueId, issues]);

  // Update Markers
  useEffect(() => {
    if (!mapInstanceRef.current || typeof window === 'undefined') return;

    import('leaflet').then((L) => {
      const map = mapInstanceRef.current;
      if (!map) return;

      Object.values(markersRef.current).forEach((marker: any) => marker.remove());
      markersRef.current = {};

      issues.forEach((issue) => {
        let markerBg = 'bg-amber-500';
        let glowColor = 'rgba(245, 158, 11, 0.35)';
        if (issue.status === 'resolved') {
          markerBg = 'bg-emerald-500';
          glowColor = 'rgba(16, 185, 129, 0.35)';
        } else if (issue.status === 'in_progress' || issue.status === 'assigned') {
          markerBg = 'bg-sky-500';
          glowColor = 'rgba(14, 165, 233, 0.35)';
        }

        const iconHtml = `
          <div class="group relative flex items-center justify-center cursor-pointer transition-transform hover:scale-110">
            <div style="box-shadow: 0 4px 15px ${glowColor};" class="w-10 h-10 rounded-2xl ${markerBg} text-white flex flex-col items-center justify-center font-bold text-xs border-2 border-white shadow-xl">
              <span class="text-xs font-mono font-black leading-none">${issue.priorityScore.toFixed(1)}</span>
              <span class="text-[8px] opacity-90 uppercase font-semibold leading-none mt-0.5">pts</span>
            </div>
            ${
              issue.reportCount > 1
                ? `<span class="absolute -top-1 -right-1 bg-rose-500 text-white text-[9px] font-bold rounded-full h-4 w-4 flex items-center justify-center border-2 border-white shadow-sm">${issue.reportCount}</span>`
                : ''
            }
          </div>
        `;

        const customIcon = L.divIcon({
          className: 'civic-issue-marker',
          html: iconHtml,
          iconSize: [40, 40],
          iconAnchor: [20, 20],
        });

        const marker = L.marker([issue.latitude, issue.longitude], { icon: customIcon })
          .addTo(map)
          .on('click', () => {
            setActiveIssue(issue);
            if (onSelectIssue) onSelectIssue(issue);
            map.flyTo([issue.latitude, issue.longitude], 16, { duration: 0.8 });
          });

        markersRef.current[issue.id] = marker;
      });
    });
  }, [issues, onSelectIssue]);

  const recenterGPS = () => {
    if (searchMarkerRef.current) {
      searchMarkerRef.current.setOpacity(0);
    }
    locateUser({ animate: true });
  };

  const pillLabel =
    locationStatus === 'granted' && initialLocation
      ? `Live · ${initialLocation.latitude.toFixed(4)}, ${initialLocation.longitude.toFixed(4)}`
      : locationStatus === 'requesting'
      ? 'Locating your position…'
      : locationStatus === 'denied'
      ? 'Location denied — tap crosshair to retry'
      : locationStatus === 'unsupported'
      ? 'Geolocation not supported'
      : gpsStatus;

  const handleUpvoteClick = async (issueId: string) => {
    setUpvotingId(issueId);
    try {
      await onUpvote(issueId);
      if (activeIssue && activeIssue.id === issueId) {
        setActiveIssue({
          ...activeIssue,
          communityUpvotes: activeIssue.communityUpvotes + 1,
          priorityScore: activeIssue.priorityScore + 0.05,
        });
      }
    } finally {
      setUpvotingId(null);
    }
  };

  return (
    <div className="relative w-full h-[calc(100dvh-4rem-4.5rem)] md:h-[calc(100vh-5rem)] flex flex-col overflow-hidden transition-colors
                    bg-slate-100 dark:bg-slate-950">
      
      {/* Floating Filter Chips with Ample Breathing Room */}
      <div className="absolute top-4 left-4 right-4 z-20 pointer-events-none flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Category horizontal scroll pills */}
        <div className="pointer-events-auto flex items-center space-x-2 overflow-x-auto p-2 rounded-2xl border shadow-lg backdrop-blur-xl no-scrollbar max-w-full
                        bg-white/90 border-slate-200/90 text-slate-700 
                        dark:bg-slate-950/90 dark:border-slate-800/90 dark:text-slate-300">
          <button
            onClick={() => onSelectCategory('all')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              selectedCategory === 'all'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/20'
                : 'hover:bg-slate-100 dark:hover:bg-slate-900 text-slate-600 dark:text-slate-400'
            }`}
          >
            All Hazards
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => onSelectCategory(cat.id)}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                selectedCategory === cat.id
                  ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/20'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-900 text-slate-600 dark:text-slate-400'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>

        {/* Status chip filter on desktop/tablet */}
        <div className="hidden sm:flex pointer-events-auto items-center space-x-1.5 p-1.5 rounded-2xl border shadow-lg backdrop-blur-xl
                        bg-white/90 border-slate-200/90 
                        dark:bg-slate-950/90 dark:border-slate-800/90">
          {(['all', 'reported', 'assigned', 'in_progress', 'resolved'] as const).map((st) => (
            <button
              key={st}
              onClick={() => onSelectStatus(st)}
              className={`px-3 py-1.5 rounded-xl text-xs capitalize font-medium transition ${
                selectedStatus === st
                  ? 'bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-emerald-400 font-bold'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {st === 'all' ? 'All' : st.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Place search — jump to any location to browse its issues */}
      <div ref={searchBoxRef} className="absolute top-[5.2rem] md:top-[4.6rem] left-1/2 -translate-x-1/2 z-20 w-[92%] max-w-md md:w-80 pointer-events-auto">
        <div className="flex items-center space-x-2 px-3 py-2.5 rounded-2xl border shadow-xl backdrop-blur-xl
                        bg-white/95 border-slate-200 text-slate-700
                        dark:bg-slate-950/95 dark:border-slate-800 dark:text-slate-200">
          <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <input
            type="text"
            value={mapQuery}
            onChange={(e) => { setMapQuery(e.target.value); setMapShowResults(true); }}
            onFocus={() => setMapShowResults(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && mapResults.length > 0) {
                e.preventDefault();
                flyToPlace(mapResults[0]);
              } else if (e.key === 'Escape') {
                setMapShowResults(false);
              }
            }}
            placeholder="Search anywhere for issues…"
            className="flex-1 min-w-0 bg-transparent text-xs sm:text-sm placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none"
          />
          {mapSearching && <Loader2 className="w-4 h-4 animate-spin text-sky-500 flex-shrink-0" />}
          {mapQuery && !mapSearching && (
            <button
              type="button"
              onClick={() => { setMapQuery(''); setMapResults([]); setMapShowResults(false); }}
              className="flex-shrink-0 p-0.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5 text-slate-400" />
            </button>
          )}
        </div>

        {mapShowResults && (mapSearching || mapSearchError || mapResults.length > 0 || mapQuery.trim().length >= 3) && (
          <div className="mt-2 max-h-64 overflow-y-auto rounded-2xl border shadow-2xl backdrop-blur-xl
                          bg-white/95 border-slate-200 text-slate-700
                          dark:bg-slate-950/95 dark:border-slate-800 dark:text-slate-200">
            {mapSearching ? (
              <p className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400 flex items-center space-x-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-500" />
                <span>Searching places…</span>
              </p>
            ) : mapSearchError ? (
              <p className="px-4 py-3 text-xs text-amber-600 dark:text-amber-400">Search unavailable — check your connection</p>
            ) : mapResults.length === 0 ? (
              <p className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">No places found — try a different name</p>
            ) : (
              mapResults.map((hit, i) => (
                <button
                  key={`${hit.lat},${hit.lon},${i}`}
                  type="button"
                  // Keep focus on the input so this click is never cancelled by a blur-triggered close
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => flyToPlace(hit)}
                  className="w-full text-left px-4 py-2.5 flex items-start space-x-2.5 transition hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <MapPin className="w-4 h-4 mt-0.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">{hit.label}</span>
                    {hit.sublabel && <span className="block text-[10px] text-slate-500 dark:text-slate-400 truncate">{hit.sublabel}</span>}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Live GPS status pill */}
      <div className="absolute left-5 bottom-6 md:bottom-8 z-20 pointer-events-none">
        <div className={`px-3 py-1.5 rounded-full border shadow-lg backdrop-blur-md text-[11px] font-semibold flex items-center space-x-1.5
                        bg-white/90 border-slate-200 text-slate-600
                        dark:bg-slate-900/90 dark:border-slate-800 dark:text-slate-300
                        ${locationStatus === 'denied' ? '!border-rose-200 !text-rose-600 dark:!border-rose-500/30 dark:!text-rose-400' : ''}`}>
          <MapPin className={`w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 ${(locating || locationStatus === 'requesting') ? 'animate-pulse' : ''}`} />
          <span className="font-mono">{pillLabel}</span>
        </div>
      </div>

      {/* Floating GPS Recenter button — sits ABOVE the Leaflet zoom + attribution
          stack (bottom-right, md+), each control spaced independently so they
          never overlap: attribution (bottom) → zoom (+/−, above) → recenter (top). */}
      <div className="absolute right-5 bottom-9 md:bottom-32 z-30 pointer-events-auto">
        <button
          onClick={recenterGPS}
          className="p-3.5 rounded-full border shadow-xl backdrop-blur-md active:scale-95 transition-all
                     bg-white/95 border-slate-200 text-slate-700 hover:bg-slate-50 
                     dark:bg-slate-900/95 dark:border-slate-800 dark:text-emerald-400 dark:hover:bg-slate-800"
          aria-label="Recenter GPS"
          title="Recenter to my location"
        >
          <Crosshair className="w-5 h-5" />
        </button>
      </div>

      {/* Main Map Viewport */}
      <div ref={mapContainerRef} className="w-full h-full z-10" />

      {/* Spacious Bottom Sheet Card for Selected Incident */}
      {activeIssue && (
        <div className="absolute bottom-4 left-4 right-4 sm:bottom-8 sm:left-auto sm:right-8 sm:w-[26rem] z-30 pointer-events-auto animate-in slide-in-from-bottom duration-300">
          <div className="rounded-3xl p-5 border shadow-2xl backdrop-blur-2xl transition-all space-y-4
                          bg-white/95 border-slate-200 text-slate-900 
                          dark:bg-slate-900/95 dark:border-slate-800/90 dark:text-slate-100">
            
            {/* Top row */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full
                               bg-emerald-50 text-emerald-700 border border-emerald-200
                               dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20">
                {activeIssue.category.name}
              </span>
              <div className="flex items-center space-x-2.5">
                <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-xl
                                 bg-amber-50 text-amber-800 border border-amber-200
                                 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20">
                  {activeIssue.priorityScore.toFixed(2)} pts
                </span>
                <button
                  onClick={() => setActiveIssue(null)}
                  className="p-1.5 rounded-full transition
                             hover:bg-slate-100 text-slate-400 hover:text-slate-700 
                             dark:hover:bg-slate-800 dark:text-slate-400 dark:hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Photo & Details with clean spacing */}
            <div className="flex space-x-4 items-center">
              <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-2xl overflow-hidden flex-shrink-0 border
                              bg-slate-100 border-slate-200 dark:bg-slate-950 dark:border-slate-800">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={activeIssue.imageUrl}
                  alt={activeIssue.title}
                  className="w-full h-full object-cover"
                />
              </div>

              <div className="flex-1 min-w-0 space-y-1">
                <h4 className="text-sm sm:text-base font-bold line-clamp-1 leading-snug">
                  {activeIssue.title}
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">
                  {activeIssue.description}
                </p>
                <div className="flex items-center text-xs text-slate-500 dark:text-slate-400 space-x-1 pt-1 truncate">
                  <MapPin className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                  <span className="truncate">{activeIssue.formattedAddress}</span>
                </div>
              </div>
            </div>

            {/* Action Bar */}
            <div className="pt-3 border-t flex items-center justify-between
                            border-slate-100 dark:border-slate-800/80">
              <div className="flex items-center space-x-2 text-xs text-slate-500 dark:text-slate-400">
                <span><strong>{activeIssue.reportCount}</strong> reports</span>
                <span>•</span>
                <span><strong>{activeIssue.communityUpvotes}</strong> upvotes</span>
              </div>

              <button
                onClick={() => handleUpvoteClick(activeIssue.id)}
                disabled={upvotingId === activeIssue.id}
                className="flex items-center space-x-2 px-4 py-2.5 rounded-2xl text-xs font-bold transition active:scale-95 disabled:opacity-50
                           bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-600/20"
              >
                <ThumbsUp className={`w-3.5 h-3.5 ${upvotingId === activeIssue.id ? 'animate-bounce' : ''}`} />
                <span>I Also Face This</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
