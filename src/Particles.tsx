import { useRef, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js';
import { useControls } from 'leva';

interface ParticlesProps {
  audioData: {
    level: number;      // Overall volume (smoothed 0-1)
    bass: number;       // 20Hz-200Hz energy (0-1)
    mid: number;        // 200Hz-2000Hz energy (0-1)
    treble: number;     // 2000Hz+ energy (0-1)
    transient: number;  // Beat detection trigger (0-1)
  };
  colorScheme: string;
  particleCount?: number;
}

const PARTICLE_COUNT = 100000;

// Calculate texture size for 100k particles
// sqrt(100000) ≈ 316, so we'll use 512x512 = 262144 (closest power of 2)
const TEXTURE_SIZE = 512;

// Simulation fragment shader - updates particle positions
const positionFragmentShader = `
  uniform float time;
  uniform float audioBass;
  uniform float audioMid;
  uniform float audioTreble;
  uniform float audioLevel;
  uniform float audioTransient;
  uniform float uCurlStrength;
  uniform float uTimeStep;
  uniform float uNoiseScale;
  uniform float uFlowSpeed;
  uniform float uCurlInfluence;
  uniform float uAudioReactivity;
  uniform vec2 resolution;
  uniform sampler2D texturePosition;
  uniform sampler2D textureVelocity;
  
  // Simplex noise function for curl noise
  vec3 mod289(vec3 x) {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
  }
  
  vec4 mod289(vec4 x) {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
  }
  
  vec4 permute(vec4 x) {
    return mod289(((x*34.0)+1.0)*x);
  }
  
  vec4 taylorInvSqrt(vec4 r) {
    return 1.79284291400159 - 0.85373472095314 * r;
  }
  
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    
    i = mod289(i);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    
    vec4 x = x_ *ns.x + ns.yyyy;
    vec4 y = y_ *ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;
    
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }
  
  // Curl noise - returns divergence-free 2D flow field
  // Curl of a scalar potential field gives a divergence-free vector field
  // This creates smooth, swirling flow patterns
  vec2 curlNoise(vec2 p, float uTime) {
    float eps = 0.1;
    
    // Sample noise at offset positions to compute partial derivatives
    // Use multiple octaves for smoother result
    float n1 = snoise(vec3(p, uTime * 0.5));
    float n2 = snoise(vec3(p + vec2(eps, 0.0), uTime * 0.5));
    float n3 = snoise(vec3(p + vec2(0.0, eps), uTime * 0.5));
    
    // Add second octave for more detail
    float n4 = snoise(vec3(p * 2.0, uTime * 0.3)) * 0.5;
    float n5 = snoise(vec3((p + vec2(eps, 0.0)) * 2.0, uTime * 0.3)) * 0.5;
    float n6 = snoise(vec3((p + vec2(0.0, eps)) * 2.0, uTime * 0.3)) * 0.5;
    
    // Combine octaves
    float combined1 = n1 + n4;
    float combined2 = n2 + n5;
    float combined3 = n3 + n6;
    
    // Compute curl: (dN/dy, -dN/dx)
    // This gives us a divergence-free vector field
    float dx = (combined2 - combined1) / eps;
    float dy = (combined3 - combined1) / eps;
    
    // Return curl vector (divergence-free, creates swirling motion)
    return vec2(dy, -dx);
  }
  
  void main() {
    vec2 uv = gl_FragCoord.xy / ${TEXTURE_SIZE.toFixed(1)}.0;
    
    // Get current position, velocity, and life from textures
    vec4 pos = texture2D(texturePosition, uv);
    vec4 vel = texture2D(textureVelocity, uv);
    
    vec3 p = pos.xyz;
    vec3 v = vel.xyz;
    float life = pos.w; // Life stored in w component (0-1, alpha)
    
    // TIME WARP: Use uTimeStep uniform (controlled by bass in useFrame)
    // Apply audio reactivity multiplier
    float timeStep = 1.0 + (uTimeStep - 1.0) * uAudioReactivity;
    float uTime = time * timeStep;
    
    // Base scale for noise
    float baseScale = 0.005;
    
    // JITTER: Use uNoiseScale uniform (controlled by treble in useFrame)
    // Apply audio reactivity multiplier
    float jitterScale = baseScale + uNoiseScale * uAudioReactivity;
    
    // Add high-frequency jitter to coordinates when treble is high
    vec2 jitteredPos = p.xy;
    if (audioTreble > 0.1 && uAudioReactivity > 0.0) {
      float jitterFreq = 10.0 + audioTreble * 50.0; // High frequency jitter
      float jitterAmount = uNoiseScale * uAudioReactivity;
      jitteredPos += vec2(
        sin(p.x * jitterFreq + uTime) * jitterAmount * 100.0,
        cos(p.y * jitterFreq + uTime) * jitterAmount * 100.0
      );
    }
    
    // DIVERGENCE & CURL: Use curl noise for velocity (divergence-free flow field)
    vec2 curl = curlNoise(jitteredPos * jitterScale, uTime);
    
    // Scale curl by uCurlStrength and uCurlInfluence uniforms
    // Apply audio reactivity multiplier
    float curlStrength = uCurlStrength * uAudioReactivity;
    curl *= curlStrength * uCurlInfluence;
    
    // Calculate particle ID from UV for variation
    float id = uv.x + uv.y * ${TEXTURE_SIZE.toFixed(1)};
    float baseSpeed = 0.5 + (id / ${(TEXTURE_SIZE * TEXTURE_SIZE).toFixed(1)}) * 1.5;
    
    // Apply flow speed and audio reactivity
    float speedMultiplier = 1.0 + audioLevel * 2.0 * uAudioReactivity;
    float speed = baseSpeed * uFlowSpeed * speedMultiplier;
    
    // Update velocity from curl noise (divergence-free flow)
    // Blend with existing velocity based on curl influence
    v.xy = mix(v.xy, curl, uCurlInfluence * 0.1);
    
    // Add some damping
    float damping = 0.98 - audioLevel * 0.05;
    v.xy *= damping;
    
    // Update position
    p.xy += v.xy * speed;
    
    // LIFE AND DEATH SYSTEM
    // Decrease life over time
    life -= 0.0005; // Natural decay
    
    // Reset particle if off-screen or life reaches 0
    bool offScreen = p.x < -resolution.x * 0.6 || p.x > resolution.x * 0.6 ||
                     p.y < -resolution.y * 0.6 || p.y > resolution.y * 0.6;
    
    if (offScreen || life <= 0.0) {
      // Respawn at random position
      float angle = (id * 137.508) * 3.14159 * 2.0; // Golden angle for distribution
      float radius = (id / ${(TEXTURE_SIZE * TEXTURE_SIZE).toFixed(1)}) * min(resolution.x, resolution.y) * 0.3;
      p.x = cos(angle) * radius;
      p.y = sin(angle) * radius;
      p.z = mod(id * 360.0, 360.0); // Random hue
      v.xy = vec2(0.0, 0.0); // Reset velocity
      life = 1.0; // Full life
    }
    
    // Store hue in z component (mod 360)
    float velocity = length(v.xy);
    p.z = mod(p.z + velocity * 0.5 + audioLevel * 2.0 + audioTransient * 5.0, 360.0);
    
    // Output: position (xyz) and life (w)
    gl_FragColor = vec4(p, life);
  }
`;

const velocityFragmentShader = `
  uniform float time;
  uniform float audioBass;
  uniform float audioMid;
  uniform float audioTreble;
  uniform float audioLevel;
  uniform float audioTransient;
  uniform vec2 resolution;
  uniform sampler2D texturePosition;
  uniform sampler2D textureVelocity;
  
  void main() {
    vec2 uv = gl_FragCoord.xy / ${TEXTURE_SIZE.toFixed(1)}.0;
    
    // Get current position and velocity from textures
    vec4 pos = texture2D(texturePosition, uv);
    vec4 vel = texture2D(textureVelocity, uv);
    
    vec3 p = pos.xyz;
    vec3 v = vel.xyz;
    
    // Velocity is updated in position shader, so we just pass it through
    // The position shader handles all the physics
    
    gl_FragColor = vec4(v, 1.0);
  }
`;

// Render vertex shader
const renderVertexShader = `
  attribute vec3 color;
  attribute float size;
  attribute float alpha;
  uniform float uParticleSize;
  
  varying vec3 vColor;
  varying float vAlpha;
  
  void main() {
    vColor = color;
    vAlpha = alpha;
    
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * uParticleSize * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const renderFragmentShader = `
  varying vec3 vColor;
  varying float vAlpha;
  
  void main() {
    float dist = distance(gl_PointCoord, vec2(0.5));
    if (dist > 0.5) discard;
    
    float alpha = vAlpha * (1.0 - dist * 2.0);
    gl_FragColor = vec4(vColor, alpha);
  }
`;

export default function Particles({ audioData, colorScheme, particleCount = PARTICLE_COUNT }: ParticlesProps) {
  const { gl, size } = useThree();
  const pointsRef = useRef<THREE.Points>(null);
  const gpuComputeRef = useRef<GPUComputationRenderer | null>(null);
  const positionVariableRef = useRef<any>(null);
  const velocityVariableRef = useRef<any>(null);
  const timeRef = useRef(0);
  
  // Leva controls for simulation parameters
  const controls = useControls('Particle Simulation', {
    flowSpeed: { value: 1.0, min: 0.0, max: 5.0, step: 0.1, label: 'Flow Speed' },
    curlInfluence: { value: 1.0, min: 0.0, max: 2.0, step: 0.1, label: 'Curl Influence' },
    audioReactivity: { value: 1.0, min: 0.0, max: 2.0, step: 0.1, label: 'Audio Reactivity Strength' },
    particleSize: { value: 1.0, min: 0.1, max: 5.0, step: 0.1, label: 'Particle Size' },
  });
  
  // Initialize GPGPU system
  const { geometry, material } = useMemo(() => {
    // Initialize GPU Computation Renderer
    const gpuCompute = new GPUComputationRenderer(TEXTURE_SIZE, TEXTURE_SIZE, gl);
    
    const error = gpuCompute.init();
    if (error !== null) {
      console.error('GPUComputationRenderer initialization failed:', error);
      return { geometry: null, material: null };
    }
    
    // Create position texture
    const dtPosition = gpuCompute.createTexture();
    fillPositionTexture(dtPosition, size.width, size.height);
    
    // Create velocity texture
    const dtVelocity = gpuCompute.createTexture();
    fillVelocityTexture(dtVelocity);
    
    // Create position variable
    const positionVariable = gpuCompute.addVariable('texturePosition', positionFragmentShader, dtPosition);
    
    // Create velocity variable (simpler, just passes through)
    const velocityVariable = gpuCompute.addVariable('textureVelocity', velocityFragmentShader, dtVelocity);
    
    // Set dependencies
    gpuCompute.setVariableDependencies(positionVariable, [positionVariable, velocityVariable]);
    gpuCompute.setVariableDependencies(velocityVariable, [positionVariable, velocityVariable]);
    
    // Get the simulation material
    const positionMaterial = positionVariable.material;
    const velocityMaterial = velocityVariable.material;
    
    // Set uniforms for position material
    positionMaterial.uniforms.time = { value: 0 };
    positionMaterial.uniforms.audioBass = { value: 0 };
    positionMaterial.uniforms.audioMid = { value: 0 };
    positionMaterial.uniforms.audioTreble = { value: 0 };
    positionMaterial.uniforms.audioLevel = { value: 0 };
    positionMaterial.uniforms.audioTransient = { value: 0 };
    positionMaterial.uniforms.uCurlStrength = { value: 0.5 };
    positionMaterial.uniforms.uTimeStep = { value: 1.0 };
    positionMaterial.uniforms.uNoiseScale = { value: 0.0 };
    positionMaterial.uniforms.uFlowSpeed = { value: 1.0 };
    positionMaterial.uniforms.uCurlInfluence = { value: 1.0 };
    positionMaterial.uniforms.uAudioReactivity = { value: 1.0 };
    positionMaterial.uniforms.resolution = { value: new THREE.Vector2(size.width, size.height) };
    positionMaterial.uniforms.texturePosition = { value: null };
    positionMaterial.uniforms.textureVelocity = { value: null };
    
    // Set uniforms for velocity material
    velocityMaterial.uniforms.time = { value: 0 };
    velocityMaterial.uniforms.audioBass = { value: 0 };
    velocityMaterial.uniforms.audioMid = { value: 0 };
    velocityMaterial.uniforms.audioTreble = { value: 0 };
    velocityMaterial.uniforms.audioLevel = { value: 0 };
    velocityMaterial.uniforms.audioTransient = { value: 0 };
    velocityMaterial.uniforms.resolution = { value: new THREE.Vector2(size.width, size.height) };
    velocityMaterial.uniforms.texturePosition = { value: null };
    velocityMaterial.uniforms.textureVelocity = { value: null };
    
    // Store references
    gpuComputeRef.current = gpuCompute;
    positionVariableRef.current = positionVariable;
    velocityVariableRef.current = velocityVariable;
    
    // Create geometry for rendering
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const sizes = new Float32Array(particleCount);
    const alphas = new Float32Array(particleCount);
    
    // Initialize with random positions
    for (let i = 0; i < particleCount; i++) {
      const i3 = i * 3;
      positions[i3] = (Math.random() - 0.5) * size.width;
      positions[i3 + 1] = (Math.random() - 0.5) * size.height;
      positions[i3 + 2] = 0;
      
      colors[i3] = 1;
      colors[i3 + 1] = 1;
      colors[i3 + 2] = 1;
      
      sizes[i] = 2.0;
      alphas[i] = 0.8;
    }
    
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    
    // Create render material
    const material = new THREE.ShaderMaterial({
      vertexShader: renderVertexShader,
      fragmentShader: renderFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      uniforms: {
        uParticleSize: { value: 1.0 },
      },
    });
    
    return { geometry, material };
  }, [gl, size, controls]);
  
  // Helper function to fill position texture
  function fillPositionTexture(texture: THREE.DataTexture, width: number, height: number) {
    const theArray = texture.image?.data;
    if (!theArray) return;
    
    const texWidth = texture.image.width;
    const texHeight = texture.image.height;
    
    for (let k = 0, kl = theArray.length; k < kl; k += 4) {
      const i = (k / 4) % texWidth;
      const j = Math.floor((k / 4) / texWidth);
      
      const x = (i / texWidth) * width - width * 0.5;
      const y = (j / texHeight) * height - height * 0.5;
      const z = Math.random() * 360; // Initial hue
      const life = 1.0; // Full life initially
      
      theArray[k + 0] = x;
      theArray[k + 1] = y;
      theArray[k + 2] = z;
      theArray[k + 3] = life; // Store life in w component
    }
  }
  
  // Helper function to fill velocity texture
  function fillVelocityTexture(texture: THREE.DataTexture) {
    const theArray = texture.image?.data;
    if (!theArray) return;
    
    for (let k = 0, kl = theArray.length; k < kl; k += 4) {
      theArray[k + 0] = 0;
      theArray[k + 1] = 0;
      theArray[k + 2] = 0;
      theArray[k + 3] = 1.0;
    }
  }
  
  const readTextureFrameRef = useRef(0);
  
  // Helper to convert HSL to RGB
  function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    let r, g, b;
    
    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    
    return [r, g, b];
  }
  
  // Update simulation
  useFrame((_state, delta) => {
    if (!gpuComputeRef.current || !positionVariableRef.current || !pointsRef.current) return;
    
    timeRef.current += delta;
    readTextureFrameRef.current++;
    
    const gpuCompute = gpuComputeRef.current;
    const positionVariable = positionVariableRef.current;
    const velocityVariable = velocityVariableRef.current;
    
    // Update uniforms for position material
    const posMaterial = positionVariable.material as THREE.ShaderMaterial;
    if (posMaterial.uniforms) {
      posMaterial.uniforms.time.value = timeRef.current;
      posMaterial.uniforms.audioBass.value = audioData.bass;
      posMaterial.uniforms.audioMid.value = audioData.mid;
      posMaterial.uniforms.audioTreble.value = audioData.treble;
      posMaterial.uniforms.audioLevel.value = audioData.level;
      posMaterial.uniforms.audioTransient.value = audioData.transient;
      
      // Map audio data to simulation parameters (with audio reactivity multiplier)
      // uCurlStrength: Reacts to mid frequencies (flow field intensity)
      posMaterial.uniforms.uCurlStrength.value = 0.5 + audioData.mid * 2.0 + audioData.transient * 1.0;
      
      // uTimeStep: Reacts to bass (Time Warp effect)
      posMaterial.uniforms.uTimeStep.value = 1.0 + audioData.bass * 2.0;
      
      // uNoiseScale: Reacts to treble (Jitter effect)
      posMaterial.uniforms.uNoiseScale.value = audioData.treble * 0.003;
      
      // Apply control panel values
      posMaterial.uniforms.uFlowSpeed.value = controls.flowSpeed;
      posMaterial.uniforms.uCurlInfluence.value = controls.curlInfluence;
      posMaterial.uniforms.uAudioReactivity.value = controls.audioReactivity;
      
      posMaterial.uniforms.resolution.value.set(size.width, size.height);
    }
    
    // Update render material uniforms
    const renderMaterial = pointsRef.current.material as THREE.ShaderMaterial;
    if (renderMaterial.uniforms) {
      renderMaterial.uniforms.uParticleSize.value = controls.particleSize;
    }
    
    // Update uniforms for velocity material
    const velMaterial = velocityVariable.material as THREE.ShaderMaterial;
    if (velMaterial.uniforms) {
      velMaterial.uniforms.time.value = timeRef.current;
      velMaterial.uniforms.audioBass.value = audioData.bass;
      velMaterial.uniforms.audioMid.value = audioData.mid;
      velMaterial.uniforms.audioTreble.value = audioData.treble;
      velMaterial.uniforms.audioLevel.value = audioData.level;
      velMaterial.uniforms.audioTransient.value = audioData.transient;
      velMaterial.uniforms.resolution.value.set(size.width, size.height);
    }
    
    // Compute on GPU
    gpuCompute.compute();
    
    // Read texture data back to update geometry (throttled for performance)
    // This is necessary because WebGL1 can't sample textures in vertex shaders
    // Only read every 2 frames to improve performance
    if (readTextureFrameRef.current % 2 === 0) {
      const renderTarget = gpuCompute.getCurrentRenderTarget(positionVariable);
      
      // Create a temporary buffer for reading
      const width = TEXTURE_SIZE;
      const height = TEXTURE_SIZE;
      const pixelBuffer = new Float32Array(width * height * 4);
      
      // Read from render target using renderer's method
      const renderer = gl as THREE.WebGLRenderer;
      renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixelBuffer);
      
      // Update geometry
      const geometry = pointsRef.current.geometry;
      const positionAttribute = geometry.getAttribute('position') as THREE.BufferAttribute;
      const colorAttribute = geometry.getAttribute('color') as THREE.BufferAttribute;
      const sizeAttribute = geometry.getAttribute('size') as THREE.BufferAttribute;
      const alphaAttribute = geometry.getAttribute('alpha') as THREE.BufferAttribute;
      
      const positions = positionAttribute.array as Float32Array;
      const colors = colorAttribute.array as Float32Array;
      const sizes = sizeAttribute.array as Float32Array;
      const alphas = alphaAttribute.array as Float32Array;
      
      // Update positions and colors from texture
      for (let i = 0; i < particleCount && i < width * height; i++) {
        const i3 = i * 3;
        const pixelIndex = i * 4;
        
        // Read position and life from texture
        positions[i3] = pixelBuffer[pixelIndex];
        positions[i3 + 1] = pixelBuffer[pixelIndex + 1];
        const hue = pixelBuffer[pixelIndex + 2]; // hue stored in z
        const life = pixelBuffer[pixelIndex + 3]; // life stored in w (0-1)
        
        // Calculate color based on scheme
        let h = hue;
        if (colorScheme === 'aurora') {
          h = (hue + timeRef.current * 20 + audioData.level * 60 + audioData.transient * 30) % 360;
        } else if (colorScheme === 'fire') {
          h = 0 + Math.sin(positions[i3 + 1] * 0.01) * 60 + audioData.bass * 30 + audioData.transient * 20;
        } else if (colorScheme === 'ocean') {
          h = 180 + Math.sin(positions[i3 + 1] * 0.01 + timeRef.current) * 60 + audioData.mid * 40 + audioData.transient * 25;
        } else {
          h = (hue + timeRef.current * 20 + audioData.level * 80 + audioData.transient * 40) % 360;
        }
        
        // Map colors to audio level: bright/hot when loud, cool/dark when quiet
        // Saturation: Higher when loud (more vibrant), lower when quiet (more muted)
        const saturation = 0.3 + audioData.level * 0.6; // Range: 0.3 to 0.9
        
        // Lightness: Higher when loud (brighter), lower when quiet (darker)
        // Also shift hue towards warmer colors (red/orange) when loud, cooler (blue/cyan) when quiet
        let lightness = 0.3 + audioData.level * 0.5; // Range: 0.3 to 0.8
        
        // Shift hue towards warm colors (0-60) when loud, cool colors (180-240) when quiet
        const warmShift = audioData.level * 30; // Shift up to 30 degrees towards warm
        const coolShift = (1.0 - audioData.level) * 30; // Shift up to 30 degrees towards cool
        h = (h + warmShift - coolShift) % 360;
        
        const color = hslToRgb(h / 360, saturation, lightness);
        colors[i3] = color[0];
        colors[i3 + 1] = color[1];
        colors[i3 + 2] = color[2];
        
        // Update size and alpha based on audio and life
        sizes[i] = 2.0 * (1 + audioData.level * 0.5 + audioData.transient * 0.3) * life; // Size decreases with life
        alphas[i] = Math.min(0.8 + audioData.level * 0.3 + audioData.transient * 0.2, 1.0) * life; // Alpha fades with life
      }
      
      positionAttribute.needsUpdate = true;
      colorAttribute.needsUpdate = true;
      sizeAttribute.needsUpdate = true;
      alphaAttribute.needsUpdate = true;
    }
  });
  
  if (!geometry || !material) {
    return null;
  }
  
  return (
    <points ref={pointsRef} geometry={geometry} material={material} />
  );
}
