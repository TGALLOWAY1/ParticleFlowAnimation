import { useRef, useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Play, Pause, Upload, Mic, MicOff } from 'lucide-react';
import Particles from './Particles';
import { useAudioAnalyzer } from './useAudioAnalyzer';

const ParticleFlowViz = () => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [particleCount] = useState(100000); // Fixed at 100k for GPGPU
  const [trailLength, setTrailLength] = useState(0.95);
  const [colorScheme, setColorScheme] = useState('aurora');
  const [useMicrophone, setUseMicrophone] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | MediaStreamAudioSourceNode | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  
  // Use the audio analyzer hook
  const audioData = useAudioAnalyzer(
    audioContextRef.current,
    analyserRef.current,
    isPlaying,
    {
      fftSize: 2048,
      smoothingTimeConstant: 0.8,
      lerpFactor: 0.15,
      transientThreshold: 0.3,
      transientDecay: 0.92,
    }
  );
  
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    try {
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
        micStreamRef.current = null;
        setUseMicrophone(false);
      }
      
      // Revoke old blob URL if exists
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
      
      if (audioElementRef.current) {
        audioElementRef.current.pause();
        audioElementRef.current.src = '';
        audioElementRef.current = null;
      }
      
      const url = URL.createObjectURL(file);
      audioUrlRef.current = url;
      
      const audio = new Audio(url);
      audio.loop = true;
      audioElementRef.current = audio;
      
      // Create audio context first
      if (!audioContextRef.current) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        audioContextRef.current = new AudioContextClass();
      }
      
      // Resume audio context if suspended (required for autoplay policies)
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      
      // Disconnect old source if exists
      if (audioSourceRef.current) {
        try {
          audioSourceRef.current.disconnect();
        } catch (e) {}
        audioSourceRef.current = null;
      }
      
      // Wait for audio to be ready before creating source
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Audio loading timeout'));
        }, 10000); // 10 second timeout
        
        audio.addEventListener('canplaythrough', () => {
          clearTimeout(timeout);
          resolve(undefined);
        }, { once: true });
        
        audio.addEventListener('error', (e) => {
          clearTimeout(timeout);
          reject(e);
        }, { once: true });
        
        audio.load();
      });
      
      // Create new source - can only create once per audio element
      try {
        const source = audioContextRef.current.createMediaElementSource(audio);
        audioSourceRef.current = source;
        
        const analyser = audioContextRef.current.createAnalyser();
        analyser.fftSize = 2048; // Increased for better frequency resolution
        analyser.smoothingTimeConstant = 0.8;
        analyserRef.current = analyser;
        
        // Connect to both analyser AND destination so we can hear it
        source.connect(analyser);
        source.connect(audioContextRef.current.destination);
      } catch (err: any) {
        // If error says "InvalidStateError", the audio element already has a source
        if (err.name === 'InvalidStateError' || err.message?.includes('already connected')) {
          console.warn('Audio source already exists, trying to use existing setup');
          // Try to create analyser from existing context
          if (!analyserRef.current) {
            const analyser = audioContextRef.current.createAnalyser();
            analyser.fftSize = 2048; // Increased for better frequency resolution
            analyser.smoothingTimeConstant = 0.8;
            analyserRef.current = analyser;
            // Try to connect if we have a source
            if (audioSourceRef.current) {
              try {
                audioSourceRef.current.connect(analyser);
              } catch (e) {
                console.error('Could not connect existing source to analyser:', e);
              }
            }
          }
        } else {
          throw err;
        }
      }
      
      // Ensure audio context is running
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      
      // Play audio
      try {
        await audio.play();
        setIsPlaying(true);
      } catch (playErr: any) {
        console.error('Error playing audio:', playErr);
        // Some browsers require user interaction
        alert('Could not play audio automatically. Please click the play button after uploading.');
        setIsPlaying(false);
      }
    } catch (err) {
      console.error('Error loading audio:', err);
      alert('Error loading audio file. Please try again.');
      // Cleanup on error
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
      if (audioElementRef.current) {
        audioElementRef.current = null;
      }
    }
  };
  
  const toggleMicrophone = async () => {
    if (useMicrophone) {
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
        micStreamRef.current = null;
      }
      if (audioSourceRef.current) {
        try {
          audioSourceRef.current.disconnect();
        } catch (e) {}
        audioSourceRef.current = null;
      }
      setUseMicrophone(false);
      setIsPlaying(false);
    } else {
      try {
        if (audioElementRef.current) {
          audioElementRef.current.pause();
        }
        
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = stream;
        
        if (!audioContextRef.current) {
          const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
          audioContextRef.current = new AudioContextClass();
        }
        
        // Resume audio context if suspended
        if (audioContextRef.current.state === 'suspended') {
          await audioContextRef.current.resume();
        }
        
        if (audioSourceRef.current) {
          try {
            audioSourceRef.current.disconnect();
          } catch (e) {}
        }
        
        const source = audioContextRef.current.createMediaStreamSource(stream);
        audioSourceRef.current = source;
        
        const analyser = audioContextRef.current.createAnalyser();
        analyser.fftSize = 2048; // Increased for better frequency resolution
        analyser.smoothingTimeConstant = 0.8;
        analyserRef.current = analyser;
        
        source.connect(analyser);
        
        setUseMicrophone(true);
        setIsPlaying(true);
      } catch (err) {
        console.error('Error accessing microphone:', err);
        alert('Could not access microphone. Please check permissions.');
      }
    }
  };
  
  const togglePlayPause = async () => {
    if (audioElementRef.current) {
      try {
        // Resume audio context if suspended
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
          await audioContextRef.current.resume();
        }
        
        if (isPlaying) {
          // Pause audio
          audioElementRef.current.pause();
          setIsPlaying(false);
        } else {
          // Play audio
          await audioElementRef.current.play();
          setIsPlaying(true);
        }
      } catch (err) {
        console.error('Playback error:', err);
        alert('Error playing audio. Please try again.');
        setIsPlaying(false);
      }
    } else if (useMicrophone) {
      setIsPlaying(!isPlaying);
    }
  };
  
  // Sync audio element state with React state
  useEffect(() => {
    const audio = audioElementRef.current;
    if (!audio) return;
    
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);
    
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    
    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [audioElementRef.current]);
  
  return (
    <div className="relative w-full h-screen bg-black overflow-hidden">
      <Canvas
        camera={{ position: [0, 0, 800], fov: 60 }}
        gl={{ alpha: false, antialias: false }}
        dpr={[1, 2]}
      >
        <color attach="background" args={['#000000']} />
        <Particles audioData={audioData} colorScheme={colorScheme} particleCount={particleCount} />
      </Canvas>
      
      <div className="absolute top-4 left-4 bg-black/70 backdrop-blur-sm rounded-lg p-4 text-white space-y-3 max-w-xs z-10">
        <h2 className="text-lg font-semibold mb-2">Particle Flow Visualizer</h2>
        
        <div className="flex gap-2">
          <button
            onClick={togglePlayPause}
            disabled={!audioElementRef.current && !useMicrophone}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg transition-colors"
          >
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          
          <label className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg cursor-pointer transition-colors">
            <Upload size={18} />
            Audio
            <input
              type="file"
              accept="audio/*"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
          
          <button
            onClick={toggleMicrophone}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
              useMicrophone ? 'bg-red-600 hover:bg-red-700' : 'bg-purple-600 hover:bg-purple-700'
            }`}
          >
            {useMicrophone ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
        </div>
        
        <div>
          <label className="block text-sm mb-1">
            Particles: {particleCount.toLocaleString()}
          </label>
          <div className="text-xs text-gray-400">Fixed at 100k for GPGPU</div>
        </div>
        
        <div>
          <label className="block text-sm mb-1">
            Trail Length: {(trailLength * 100).toFixed(0)}%
          </label>
          <input
            type="range"
            min="0.8"
            max="0.99"
            step="0.01"
            value={trailLength}
            onChange={(e) => setTrailLength(Number(e.target.value))}
            className="w-full"
          />
        </div>
        
        <div>
          <label className="block text-sm mb-1">Color Scheme</label>
          <select
            value={colorScheme}
            onChange={(e) => setColorScheme(e.target.value)}
            className="w-full px-3 py-2 bg-gray-800 rounded-lg"
          >
            <option value="aurora">Aurora</option>
            <option value="fire">Fire</option>
            <option value="ocean">Ocean</option>
            <option value="rainbow">Rainbow</option>
          </select>
        </div>
      </div>
    </div>
  );
};

export default ParticleFlowViz;
