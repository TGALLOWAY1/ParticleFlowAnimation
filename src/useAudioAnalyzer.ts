import { useRef, useEffect, useState, useCallback } from 'react';

export interface AudioAnalyzerData {
  level: number;      // Overall volume (smoothed 0-1)
  bass: number;       // 20Hz-200Hz energy (0-1)
  mid: number;        // 200Hz-2000Hz energy (0-1)
  treble: number;     // 2000Hz+ energy (0-1)
  transient: number;  // Beat detection trigger (0-1, spikes on beats)
}

interface UseAudioAnalyzerOptions {
  smoothingTimeConstant?: number;
  fftSize?: number;
  lerpFactor?: number; // Smoothing factor for lerp (0-1, higher = more smoothing)
  transientThreshold?: number; // Threshold for beat detection
  transientDecay?: number; // How fast transient decays
}

// Linear interpolation helper
function lerp(start: number, end: number, factor: number): number {
  return start + (end - start) * factor;
}

// Map frequency to FFT bin index
function frequencyToBin(frequency: number, sampleRate: number, fftSize: number): number {
  return Math.floor((frequency / sampleRate) * fftSize);
}

export function useAudioAnalyzer(
  audioContext: AudioContext | null,
  analyserNode: AnalyserNode | null,
  isPlaying: boolean,
  options: UseAudioAnalyzerOptions = {}
): AudioAnalyzerData {
  const {
    smoothingTimeConstant = 0.8,
    fftSize = 2048,
    lerpFactor = 0.15, // Smooth but responsive
    transientThreshold = 0.3, // 30% increase triggers beat
    transientDecay = 0.92, // Decays 8% per frame
  } = options;

  const [audioData, setAudioData] = useState<AudioAnalyzerData>({
    level: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    transient: 0,
  });

  // Store smoothed values for lerp
  const smoothedRef = useRef<AudioAnalyzerData>({
    level: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    transient: 0,
  });

  // Store previous values for transient detection
  const previousLevelRef = useRef(0);
  const transientValueRef = useRef(0);
  const frameIdRef = useRef<number | null>(null);

  // Configure analyser if it exists
  useEffect(() => {
    if (analyserNode) {
      analyserNode.smoothingTimeConstant = smoothingTimeConstant;
      analyserNode.fftSize = fftSize;
    }
  }, [analyserNode, smoothingTimeConstant, fftSize]);

  // Analysis loop
  useEffect(() => {
    if (!isPlaying || !analyserNode || !audioContext) {
      // Reset values when not playing
      setAudioData({
        level: 0,
        bass: 0,
        mid: 0,
        treble: 0,
        transient: 0,
      });
      smoothedRef.current = {
        level: 0,
        bass: 0,
        mid: 0,
        treble: 0,
        transient: 0,
      };
      previousLevelRef.current = 0;
      transientValueRef.current = 0;
      return;
    }

    const sampleRate = audioContext.sampleRate;
    const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
    const binCount = analyserNode.frequencyBinCount;

      // Calculate frequency band bin ranges
      // Ensure bins are within valid range
      const bassStartBin = Math.max(0, Math.min(frequencyToBin(20, sampleRate, fftSize), binCount - 1));
      const bassEndBin = Math.max(bassStartBin + 1, Math.min(frequencyToBin(200, sampleRate, fftSize), binCount - 1));
      const midStartBin = bassEndBin;
      const midEndBin = Math.max(midStartBin + 1, Math.min(frequencyToBin(2000, sampleRate, fftSize), binCount - 1));
      const trebleStartBin = midEndBin;
      const trebleEndBin = binCount - 1;

    const analyze = () => {
      if (!isPlaying || !analyserNode) {
        if (frameIdRef.current) {
          cancelAnimationFrame(frameIdRef.current);
          frameIdRef.current = null;
        }
        return;
      }

      // Get frequency data
      analyserNode.getByteFrequencyData(dataArray);

      // Calculate raw frequency band energies
      let bassEnergy = 0;
      let midEnergy = 0;
      let trebleEnergy = 0;
      let totalEnergy = 0;

      // Bass: 20Hz - 200Hz
      const bassBinCount = Math.max(1, bassEndBin - bassStartBin);
      for (let i = bassStartBin; i < bassEndBin && i < binCount; i++) {
        const value = dataArray[i] / 255;
        bassEnergy += value;
        totalEnergy += value;
      }
      bassEnergy /= bassBinCount;

      // Mid: 200Hz - 2000Hz
      const midBinCount = Math.max(1, midEndBin - midStartBin);
      for (let i = midStartBin; i < midEndBin && i < binCount; i++) {
        const value = dataArray[i] / 255;
        midEnergy += value;
        totalEnergy += value;
      }
      midEnergy /= midBinCount;

      // Treble: 2000Hz+
      const trebleBinCount = Math.max(1, trebleEndBin - trebleStartBin);
      for (let i = trebleStartBin; i <= trebleEndBin && i < binCount; i++) {
        const value = dataArray[i] / 255;
        trebleEnergy += value;
        totalEnergy += value;
      }
      trebleEnergy /= trebleBinCount;

      // Overall level (weighted average)
      const overallLevel = (
        bassEnergy * 0.3 +
        midEnergy * 0.4 +
        trebleEnergy * 0.3
      );

      // Transient detection (beat detection)
      const levelDelta = overallLevel - previousLevelRef.current;
      const levelIncrease = levelDelta > 0 ? levelDelta : 0;
      
      // Trigger transient if level increases significantly
      if (levelIncrease > transientThreshold && overallLevel > 0.1) {
        transientValueRef.current = Math.min(1.0, levelIncrease * 2); // Scale and clamp
      }

      // Decay transient
      transientValueRef.current *= transientDecay;

      // Apply lerp smoothing
      const smoothed = smoothedRef.current;
      smoothed.level = lerp(smoothed.level, overallLevel, lerpFactor);
      smoothed.bass = lerp(smoothed.bass, bassEnergy, lerpFactor);
      smoothed.mid = lerp(smoothed.mid, midEnergy, lerpFactor);
      smoothed.treble = lerp(smoothed.treble, trebleEnergy, lerpFactor);
      smoothed.transient = lerp(smoothed.transient, transientValueRef.current, 0.3); // Faster response for transients

      // Update state
      setAudioData({
        level: smoothed.level,
        bass: smoothed.bass,
        mid: smoothed.mid,
        treble: smoothed.treble,
        transient: smoothed.transient,
      });

      // Store previous level for next frame
      previousLevelRef.current = overallLevel;

      // Continue loop
      frameIdRef.current = requestAnimationFrame(analyze);
    };

    // Start analysis loop
    frameIdRef.current = requestAnimationFrame(analyze);

    return () => {
      if (frameIdRef.current) {
        cancelAnimationFrame(frameIdRef.current);
        frameIdRef.current = null;
      }
    };
  }, [isPlaying, analyserNode, audioContext, fftSize, lerpFactor, transientThreshold, transientDecay]);

  return audioData;
}
