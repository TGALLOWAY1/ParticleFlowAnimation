import { useRef, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GPUComputationRenderer, Variable } from 'three/examples/jsm/misc/GPUComputationRenderer.js';
import { useControls, button } from 'leva';

interface ParticlesProps {
  audioData: {
    level: number;
    bass: number;
    mid: number;
    treble: number;
    transient: number;
  };
  colorScheme: string;
  particleCount?: number;
}

const PARTICLE_COUNT = 100000;
const TEXTURE_SIZE = 512;

// --- SHADERS ---

const positionFragmentShader = `
  uniform float time;
  uniform float uFlowSpeed;
  uniform vec2 uResolution;
  uniform float audioBass;
  uniform float audioTreble;
  uniform float uCurlInfluence;
  uniform float uNoiseScale;

  // --- SIMPLEX NOISE (Standard implementation) ---
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
             -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy) );
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1;
    i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
    + i.x + vec3(0.0, i1.x, 1.0 ));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m ;
    m = m*m ;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5); // TYPO FIXED HERE
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  // --- CURL NOISE ---
  vec2 curlNoise(vec2 p, float t, float scale) {
    float eps = 0.1;
    // Base noise
    float n1 = snoise(vec2(p.x * scale, p.y * scale + t));
    // Offset x
    float n2 = snoise(vec2((p.x + eps) * scale, p.y * scale + t));
    // Offset y
    float n3 = snoise(vec2(p.x * scale, (p.y + eps) * scale + t));
    
    // Curl = (dNoise/dy, -dNoise/dx)
    float a = (n3 - n1) / eps;
    float b = (n2 - n1) / eps;
    return vec2(a, -b);
  }

  // Pseudo-random generator for respawning
  float rand(vec2 co){
    return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution.xy;
    vec4 pos = texture2D(texturePosition, uv);
    vec3 p = pos.xyz;
    float life = pos.w;

    // --- AUDIO REACTIVE PHYSICS ---
    
    // 1. Time Step (The "Time Warp")
    // Bass makes the flow evolve faster
    float timeStep = time * (0.2 + audioBass * 0.5);

    // 2. Noise Scale (The "Jitter")
    // Treble makes the field "crunchy" / high frequency
    float noiseScale = 0.003 + (uNoiseScale * audioTreble * 0.02);

    // 3. Calculate Velocity (Curl Noise)
    vec2 velocity = curlNoise(p.xy, timeStep, noiseScale);
    
    // 4. Apply Speed
    // Overall volume makes particles move faster
    float speed = uFlowSpeed * (1.0 + audioLevel * 3.0);
    p.xy += velocity * speed * (1.0 + uCurlInfluence);
    
    // 5. Life Cycle
    life -= 0.003 * (1.0 + audioLevel); // Die faster when music is loud

    // 6. Respawn Logic
    bool outOfBounds = abs(p.x) > 800.0 || abs(p.y) > 500.0;
    
    if (outOfBounds || life <= 0.0) {
      // Respawn in a random area in the center
      vec2 seed = uv + vec2(time);
      p.x = (rand(seed) - 0.5) * 1000.0;
      p.y = (rand(seed + 1.0) - 0.5) * 600.0;
      p.z = 0.0;
      life = 1.0; // Reset life
    }

    gl_FragColor = vec4(p, life);
  }
`;

const renderVertexShader = `
  uniform sampler2D uTexturePosition;
  uniform float uParticleSize;
  uniform float uPixelRatio;
  
  attribute vec2 reference;
  
  varying vec3 vColor;
  varying float vLife;
  
  void main() {
    // Read position from texture
    vec4 posData = texture2D(uTexturePosition, reference);
    vec3 pos = posData.xyz;
    float life = posData.w;
    
    // Fade out as life decreases
    float alpha = smoothstep(0.0, 0.2, life); // Fade in quickly
    alpha *= smoothstep(1.0, 0.8, life); // Fade out slowly
    vLife = alpha;
    
    // Color Mapping
    // Cool Blue/Purple default
    vec3 colorCold = vec3(0.1, 0.3, 0.9); 
    // Hot Orange/White for energy
    vec3 colorHot = vec3(1.0, 0.6, 0.1);
    
    // Mix based on life and position speed (simulated by life decay)
    vColor = mix(colorHot, colorCold, life);

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    
    // Size attenuation (bigger when close)
    gl_PointSize = uParticleSize * uPixelRatio * (1200.0 / -mvPosition.z);
    
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const renderFragmentShader = `
  varying vec3 vColor;
  varying float vLife;
  
  void main() {
    // Soft circular particle
    vec2 cxy = 2.0 * gl_PointCoord - 1.0;
    float r = dot(cxy, cxy);
    if (r > 1.0) discard;
    
    // Soft edge glow
    float alpha = vLife * (1.0 - r) * 0.8;
    
    gl_FragColor = vec4(vColor, alpha);
  }
`;

export default function Particles({ audioData, particleCount = PARTICLE_COUNT }: ParticlesProps) {
  const { gl, size: canvasSize } = useThree();
  const gpuComputeRef = useRef<GPUComputationRenderer | null>(null);
  const positionVariableRef = useRef<any>(null); // Using any to avoid TS complexity with GPGPU lib
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  const controls = useControls('Particle Simulation', {
    flowSpeed: { value: 1.5, min: 0.0, max: 5.0 },
    particleSize: { value: 3.0, min: 0.1, max: 20.0 },
    curlInfluence: { value: 1.0, min: 0.0, max: 5.0 },
    noiseScale: { value: 0.1, min: 0.0, max: 1.0 },
  });

  const { geometry, initialTexture } = useMemo(() => {
    // 1. Setup GPGPU
    const gpuCompute = new GPUComputationRenderer(TEXTURE_SIZE, TEXTURE_SIZE, gl);
    
    // Use HalfFloatType for Mac compatibility
    if (gl.capabilities.isWebGL2) {
      gpuCompute.setDataType(THREE.HalfFloatType);
    } else {
      gpuCompute.setDataType(THREE.FloatType);
    }

    const dtPosition = gpuCompute.createTexture();
    const data = dtPosition.image.data;
    
    if (data) {
        for (let i = 0; i < data.length; i += 4) {
            // Random initial positions
            data[i] = (Math.random() - 0.5) * 1000;
            data[i + 1] = (Math.random() - 0.5) * 600;
            data[i + 2] = 0;
            data[i + 3] = Math.random(); // Random start life
        }
    }

    const posVar = gpuCompute.addVariable('texturePosition', positionFragmentShader, dtPosition);
    gpuCompute.setVariableDependencies(posVar, [posVar]);
    
    // Initialize Uniforms
    const uniforms = posVar.material.uniforms;
    uniforms.time = { value: 0 };
    uniforms.uFlowSpeed = { value: 1.0 };
    uniforms.uResolution = { value: new THREE.Vector2(TEXTURE_SIZE, TEXTURE_SIZE) };
    uniforms.audioBass = { value: 0 };
    uniforms.audioTreble = { value: 0 };
    uniforms.audioLevel = { value: 0 };
    uniforms.uCurlInfluence = { value: 1.0 };
    uniforms.uNoiseScale = { value: 0.1 };

    const error = gpuCompute.init();
    if (error !== null) console.error("GPGPU Init Error:", error);

    gpuComputeRef.current = gpuCompute;
    positionVariableRef.current = posVar;

    // 2. Render Geometry
    const geom = new THREE.BufferGeometry();
    const references = new Float32Array(particleCount * 2);
    
    for (let i = 0; i < particleCount; i++) {
      const x = (i % TEXTURE_SIZE) / TEXTURE_SIZE;
      const y = Math.floor(i / TEXTURE_SIZE) / TEXTURE_SIZE;
      references[i * 2] = x + (0.5 / TEXTURE_SIZE);
      references[i * 2 + 1] = y + (0.5 / TEXTURE_SIZE);
    }

    geom.setAttribute('reference', new THREE.BufferAttribute(references, 2));
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 5000);

    return { geometry: geom, initialTexture: dtPosition };
  }, [gl, particleCount]);

  useFrame((state) => {
    if (!gpuComputeRef.current || !positionVariableRef.current) return;

    // 1. Update Simulation Uniforms
    const computeMat = positionVariableRef.current.material;
    computeMat.uniforms.time.value = state.clock.elapsedTime;
    
    // Control Panel
    computeMat.uniforms.uFlowSpeed.value = controls.flowSpeed;
    computeMat.uniforms.uCurlInfluence.value = controls.curlInfluence;
    computeMat.uniforms.uNoiseScale.value = controls.noiseScale;
    
    // Audio Data
    computeMat.uniforms.audioBass.value = audioData.bass;
    computeMat.uniforms.audioTreble.value = audioData.treble;
    computeMat.uniforms.audioLevel.value = audioData.level;
    
    gpuComputeRef.current.compute();

    // 2. Update Render Uniforms
    if (materialRef.current) {
      const target = gpuComputeRef.current.getCurrentRenderTarget(positionVariableRef.current);
      materialRef.current.uniforms.uTexturePosition.value = target.texture;
      materialRef.current.uniforms.uParticleSize.value = controls.particleSize;
    }
  });

  return (
    <points geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        ref={materialRef}
        vertexShader={renderVertexShader}
        fragmentShader={renderFragmentShader}
        uniforms={{
          uTexturePosition: { value: initialTexture },
          uParticleSize: { value: 3.0 },
          uPixelRatio: { value: gl.getPixelRatio() }
        }}
        transparent={true}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}