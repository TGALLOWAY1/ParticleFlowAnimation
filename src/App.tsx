import { useRef, useEffect, useState } from 'react';
import { Play, Pause, Upload, Mic, MicOff } from 'lucide-react';

const ParticleFlowViz = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [particleCount, setParticleCount] = useState(3000);
  const [trailLength, setTrailLength] = useState(0.95);
  const [colorScheme, setColorScheme] = useState('aurora');
  const [useMicrophone, setUseMicrophone] = useState(false);
  
  const animationRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | MediaStreamAudioSourceNode | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioUrlRef = useRef<string | null>(null); // Track blob URLs for cleanup
  const particlesRef = useRef<any[]>([]); // Persist particles across renders
  const isPlayingRef = useRef(false); // Track playing state for animation loop
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const canvasWidth = window.innerWidth;
    const canvasHeight = window.innerHeight;
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    
    // Perlin noise implementation
    class PerlinNoise {
      gradients: { [key: string]: { x: number; y: number } };
      memory: { [key: string]: number };
      
      constructor() {
        this.gradients = {};
        this.memory = {};
      }
      
      rand_vect() {
        const theta = Math.random() * 2 * Math.PI;
        return { x: Math.cos(theta), y: Math.sin(theta) };
      }
      
      dot_prod_grid(x: number, y: number, vx: number, vy: number) {
        let g_vect;
        const d_vect = { x: x - vx, y: y - vy };
        const grid_key = `${vx},${vy}`;
        
        if (this.gradients[grid_key]) {
          g_vect = this.gradients[grid_key];
        } else {
          g_vect = this.rand_vect();
          this.gradients[grid_key] = g_vect;
        }
        
        return d_vect.x * g_vect.x + d_vect.y * g_vect.y;
      }
      
      smootherstep(x: number) {
        return 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3;
      }
      
      interp(x: number, a: number, b: number) {
        return a + this.smootherstep(x) * (b - a);
      }
      
      get(x: number, y: number) {
        const key = `${x},${y}`;
        if (this.memory[key]) return this.memory[key];
        
        const xf = Math.floor(x);
        const yf = Math.floor(y);
        
        const tl = this.dot_prod_grid(x, y, xf, yf);
        const tr = this.dot_prod_grid(x, y, xf + 1, yf);
        const bl = this.dot_prod_grid(x, y, xf, yf + 1);
        const br = this.dot_prod_grid(x, y, xf + 1, yf + 1);
        
        const xt = this.interp(x - xf, tl, tr);
        const xb = this.interp(x - xf, bl, br);
        const v = this.interp(y - yf, xt, xb);
        
        this.memory[key] = v;
        return v;
      }
    }
    
    const noise = new PerlinNoise();
    const scale = 0.005;
    let time = 0;
    let beatIntensity = 0;
    let audioLevel = 0;
    let frequencyData = {
      bass: 0,
      lowMid: 0,
      mid: 0,
      highMid: 0,
      treble: 0,
      overall: 0
    };
    
    // Clear old gradients periodically to prevent memory leak
    let frameCount = 0;
    
    // Define Particle class before using it
    class Particle {
      x: number;
      y: number;
      vx: number;
      vy: number;
      baseSpeed: number;
      speed: number;
      hue: number;
      baseSize: number;
      size: number;
      
      constructor(canvasWidth: number, canvasHeight: number) {
        this.x = Math.random() * canvasWidth;
        this.y = Math.random() * canvasHeight;
        this.vx = 0;
        this.vy = 0;
        this.baseSpeed = 0.5 + Math.random() * 1.5;
        this.speed = this.baseSpeed;
        this.hue = Math.random() * 360;
        this.baseSize = 1.5 + Math.random() * 1.5;
        this.size = this.baseSize;
      }
      
      update(fieldRotation: number, audioData: { bass: number; lowMid: number; mid: number; highMid: number; treble: number; overall: number }, canvasWidth: number, canvasHeight: number) {
        // Audio-reactive speed multiplier
        const speedMultiplier = 1 + audioData.overall * 2;
        this.speed = this.baseSpeed * speedMultiplier;
        
        // Audio-reactive turbulence
        const turbulence = audioData.mid * 3;
        const n1 = noise.get(this.x * scale, this.y * scale + time * 0.5);
        const n2 = noise.get(this.x * scale + 100, this.y * scale + time * 0.5);
        
        // Field rotation affected by bass
        const dynamicRotation = fieldRotation + audioData.bass * 0.5;
        let angle = n1 * Math.PI * 2 + dynamicRotation;
        
        // Force affected by audio intensity
        const force = (n2 * 2 + audioData.overall * 1.5) * (1 + turbulence);
        
        // Add audio-reactive directional push
        const audioPush = audioData.bass * 0.3;
        angle += Math.sin(time * 2 + this.x * 0.01) * audioPush;
        
        this.vx += Math.cos(angle) * force * 0.1;
        this.vy += Math.sin(angle) * force * 0.1;
        
        // Damping affected by audio
        const damping = 0.95 - audioData.overall * 0.1;
        this.vx *= damping;
        this.vy *= damping;
        
        this.x += this.vx * this.speed;
        this.y += this.vy * this.speed;
        
        if (this.x < 0) this.x = canvasWidth;
        if (this.x > canvasWidth) this.x = 0;
        if (this.y < 0) this.y = canvasHeight;
        if (this.y > canvasHeight) this.y = 0;
        
        const velocity = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        // Hue shift affected by audio
        this.hue += velocity * 0.5 + audioData.overall * 2;
        
        // Size affected by audio
        this.size = this.baseSize * (1 + audioData.overall * 0.5);
      }
      
      draw(ctx: CanvasRenderingContext2D, scheme: string, audioData: { bass: number; lowMid: number; mid: number; highMid: number; treble: number; overall: number }) {
        const velocity = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        const baseAlpha = Math.min(velocity * 0.3 + 0.3, 1);
        // Alpha boosted by audio
        const alpha = Math.min(baseAlpha + audioData.overall * 0.3, 1);
        
        let color;
        if (scheme === 'aurora') {
          // More reactive to audio
          const h = (this.hue + time * 20 + audioData.overall * 60) % 360;
          const s = 70 + Math.sin(this.y * 0.01) * 30 + audioData.mid * 20;
          const l = 50 + velocity * 10 + audioData.overall * 30;
          color = `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
        } else if (scheme === 'fire') {
          const h = 0 + Math.sin(this.y * 0.01) * 60 + audioData.bass * 30;
          const s = 100;
          const l = 40 + velocity * 15 + audioData.overall * 40;
          color = `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
        } else if (scheme === 'ocean') {
          const h = 180 + Math.sin(this.y * 0.01 + time) * 60 + audioData.mid * 40;
          const s = 70 + Math.cos(this.x * 0.01) * 30 + audioData.overall * 20;
          const l = 40 + velocity * 10 + audioData.overall * 30;
          color = `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
        } else {
          // Rainbow mode - more reactive
          const h = (this.hue + time * 20 + audioData.overall * 80) % 360;
          const s = 70 + audioData.mid * 30;
          const l = 60 + audioData.overall * 30;
          color = `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
        }
        
        ctx.fillStyle = color;
        ctx.fillRect(this.x, this.y, this.size, this.size);
      }
    }
    
    // Initialize or adjust particles based on particleCount
    if (particlesRef.current.length === 0) {
      for (let i = 0; i < particleCount; i++) {
        particlesRef.current.push(new Particle(canvasWidth, canvasHeight));
      }
    } else {
      // Adjust particle count when it changes
      while (particlesRef.current.length < particleCount) {
        particlesRef.current.push(new Particle(canvasWidth, canvasHeight));
      }
      while (particlesRef.current.length > particleCount) {
        particlesRef.current.pop();
      }
    }
    
    let lastBeatTime = 0;
    let fieldRotation = 0;
    
    // Keep ref in sync with state
    isPlayingRef.current = isPlaying;
    
    const animate = () => {
      // Safety check - ensure canvas and context exist
      if (!canvas || !ctx) {
        animationRef.current = null;
        return;
      }
      
      // Always continue the loop, but only draw when playing
      if (isPlayingRef.current) {
        ctx.fillStyle = `rgba(0, 0, 0, ${1 - trailLength})`;
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        
        // Clear noise cache every 50 frames to prevent memory leak (very aggressive)
        frameCount++;
        if (frameCount % 50 === 0) {
          // Aggressively limit cache size
          const memoryKeys = Object.keys(noise.memory);
          if (memoryKeys.length > 500) {
            // Clear all but keep last 200
            for (let i = 0; i < memoryKeys.length - 200; i++) {
              delete noise.memory[memoryKeys[i]];
            }
          }
          const gradientKeys = Object.keys(noise.gradients);
          if (gradientKeys.length > 300) {
            // Clear all but keep last 100
            for (let i = 0; i < gradientKeys.length - 100; i++) {
              delete noise.gradients[gradientKeys[i]];
            }
          }
        }
        
        // Enhanced audio analysis with multiple frequency bands
        if (analyserRef.current) {
        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(dataArray);
        
        const binCount = dataArray.length;
        // Divide frequency spectrum into bands
        const bassEnd = Math.max(1, Math.floor(binCount * 0.05));
        const lowMidEnd = Math.max(bassEnd + 1, Math.floor(binCount * 0.15));
        const midEnd = Math.max(lowMidEnd + 1, Math.floor(binCount * 0.35));
        const highMidEnd = Math.max(midEnd + 1, Math.floor(binCount * 0.65));
        
        frequencyData.bass = dataArray.slice(0, bassEnd).reduce((a, b) => a + b, 0) / bassEnd / 255;
        frequencyData.lowMid = dataArray.slice(bassEnd, lowMidEnd).reduce((a, b) => a + b, 0) / (lowMidEnd - bassEnd) / 255;
        frequencyData.mid = dataArray.slice(lowMidEnd, midEnd).reduce((a, b) => a + b, 0) / (midEnd - lowMidEnd) / 255;
        frequencyData.highMid = dataArray.slice(midEnd, highMidEnd).reduce((a, b) => a + b, 0) / (highMidEnd - midEnd) / 255;
        frequencyData.treble = dataArray.slice(highMidEnd).reduce((a, b) => a + b, 0) / (binCount - highMidEnd) / 255;
        
        // Overall audio level (weighted average)
        frequencyData.overall = (
          frequencyData.bass * 0.3 +
          frequencyData.lowMid * 0.2 +
          frequencyData.mid * 0.25 +
          frequencyData.highMid * 0.15 +
          frequencyData.treble * 0.1
        );
        
        audioLevel = frequencyData.overall;
        
        // Beat detection with multiple frequency bands
        const bassValue = dataArray.slice(0, bassEnd).reduce((a, b) => a + b, 0) / bassEnd;
        if (bassValue > 200 && Date.now() - lastBeatTime > 200) {
          beatIntensity = 1;
          lastBeatTime = Date.now();
        }
      } else {
        // Reset when no audio
        frequencyData.bass = 0;
        frequencyData.lowMid = 0;
          frequencyData.mid = 0;
          frequencyData.highMid = 0;
          frequencyData.treble = 0;
          frequencyData.overall = 0;
        }
        
        beatIntensity *= 0.9;
        fieldRotation += beatIntensity * 0.5 + frequencyData.bass * 0.3;
        time += 0.001 + audioLevel * 0.002;
        
        // Simplified particle management - no dynamic growth to prevent memory issues
        // Just ensure we have the right number of particles
        const currentCount = particlesRef.current.length;
        if (currentCount !== particleCount) {
          if (currentCount < particleCount) {
            const toAdd = particleCount - currentCount;
            for (let i = 0; i < toAdd; i++) {
              particlesRef.current.push(new Particle(canvasWidth, canvasHeight));
            }
          } else {
            const toRemove = currentCount - particleCount;
            for (let i = 0; i < toRemove; i++) {
              particlesRef.current.pop();
            }
          }
        }
        
        particlesRef.current.forEach(p => {
          p.update(fieldRotation, frequencyData, canvasWidth, canvasHeight);
          p.draw(ctx, colorScheme, frequencyData);
        });
      }
      
      // Always continue the loop
      animationRef.current = requestAnimationFrame(animate);
    };
    
    // Start animation loop (always runs, but only draws when playing)
    if (!animationRef.current) {
      animationRef.current = requestAnimationFrame(animate);
    }
    
    const handleResize = () => {
      if (canvas) {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
      }
    };
    
    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [particleCount, trailLength, colorScheme]); // Removed isPlaying from dependencies
  
  // Sync isPlaying state with ref
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);
  
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
        analyser.fftSize = 512;
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
            analyser.fftSize = 512;
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
        isPlayingRef.current = true;
      } catch (playErr: any) {
        console.error('Error playing audio:', playErr);
        // Some browsers require user interaction
        alert('Could not play audio automatically. Please click the play button after uploading.');
        setIsPlaying(false);
        isPlayingRef.current = false;
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
        analyser.fftSize = 512;
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
    
    const handlePlay = () => {
      setIsPlaying(true);
      isPlayingRef.current = true;
    };
    const handlePause = () => {
      setIsPlaying(false);
      isPlayingRef.current = false;
    };
    const handleEnded = () => {
      setIsPlaying(false);
      isPlayingRef.current = false;
    };
    
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
      <canvas ref={canvasRef} className="absolute inset-0" />
      
      <div className="absolute top-4 left-4 bg-black/70 backdrop-blur-sm rounded-lg p-4 text-white space-y-3 max-w-xs">
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
            Particles: {particleCount}
          </label>
          <input
            type="range"
            min="500"
            max="8000"
            step="500"
            value={particleCount}
            onChange={(e) => setParticleCount(Number(e.target.value))}
            className="w-full"
          />
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