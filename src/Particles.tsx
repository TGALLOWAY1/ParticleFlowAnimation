import { useRef, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js';
import { useControls } from 'leva';

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

// FIX: Renamed 'resolution' to 'uResolution' to avoid macro collisions
// FIX: Removed 'uniform sampler2D texturePosition' (auto-added by renderer)
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
  uniform vec2 uResolution; // Renamed from resolution

  // Simplex noise function
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

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

  vec2 curlNoise(vec2 p, float t) {
    float eps = 0.1;
    float n1 = snoise(vec3(p, t));
    float n2 = snoise(vec3(p + vec2(eps, 0.0), t));
    float n3 = snoise(vec3(p + vec2(0.0, eps), t));
    float x = (n2 - n1) / eps;
    float y = (n3 - n1) / eps;
    return vec2(y, -x);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution.xy;
    
    // texturePosition is automatically defined by addVariable
    vec4 pos = texture2D(texturePosition, uv);
    vec3 p = pos.xyz;
    float life = pos.w;

    float timeStep = uTimeStep * (1.0 + audioBass * 2.0);
    float t = time * 0.1 * timeStep;
    
    float noiseScale = 0.005 + (audioTreble * uNoiseScale);
    
    // Calculate Curl Noise
    vec2 curl = curlNoise(p.xy * noiseScale, t);
    
    // Apply forces
    float speed = uFlowSpeed * (1.0 + audioLevel * 2.0);
    p.xy += curl * uCurlInfluence * speed * 0.1;
    
    // Life cycle
    life -= 0.002;
    
    // Bounds check and reset
    if (abs(p.x) > 500.0 || abs(p.y) > 500.0 || life <= 0.0) {
      // Reset to random position near center
      vec2 seed = uv + vec2(time);
      float r = fract(sin(dot(seed, vec2(12.9898, 78.233))) * 43758.5453);
      float angle = r * 6.28;
      float dist = fract(sin(dot(seed + 1.0, vec2(12.9898, 78.233))) * 43758.5453) * 100.0;
      
      p.x = cos(angle) * dist;
      p.y = sin(angle) * dist;
      p.z = 0.0;
      life = 1.0;
    }

    gl_FragColor = vec4(p, life);
  }
`;

const renderVertexShader = `
  uniform sampler2D uTexturePosition;
  uniform float uParticleSize;
  uniform float uPixelRatio;
  
  attribute vec2 reference; // UV coordinate to read from texture
  attribute float size;
  
  varying float vAlpha;
  varying vec3 vColor;
  
  void main() {
    // Read position from the GPGPU texture
    vec4 posData = texture2D(uTexturePosition, reference);
    vec3 pos = posData.xyz;
    float life = posData.w;
    
    vAlpha = life;
    
    // Simple heatmap color based on life
    vColor = mix(vec3(0.1, 0.2, 0.5), vec3(0.2, 0.8, 1.0), life);

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    
    // Size attenuation
    gl_PointSize = size * uParticleSize * uPixelRatio * (2000.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const renderFragmentShader = `
  varying float vAlpha;
  varying vec3 vColor;
  
  void main() {
    // Circular particle
    vec2 cxy = 2.0 * gl_PointCoord - 1.0;
    if (dot(cxy, cxy) > 1.0) discard;
    
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

export default function Particles({ audioData, particleCount = PARTICLE_COUNT }: ParticlesProps) {
  const { gl } = useThree();
  const gpuComputeRef = useRef<GPUComputationRenderer | null>(null);
  const positionVariableRef = useRef<any>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  const controls = useControls('Particle Simulation', {
    flowSpeed: { value: 1.5, min: 0.0, max: 5.0 },
    particleSize: { value: 4.0, min: 0.1, max: 20.0 },
    curlInfluence: { value: 1.0, min: 0.0, max: 5.0 },
    noiseScale: { value: 0.01, min: 0.0, max: 0.1 },
  });

  const { geometry } = useMemo(() => {
    // 1. Setup GPGPU
    const gpuCompute = new GPUComputationRenderer(TEXTURE_SIZE, TEXTURE_SIZE, gl);
    
    // Initial positions
    const dtPosition = gpuCompute.createTexture();
    const image = dtPosition.image;
    if (image && image.data) {
      const data = image.data;
      for (let i = 0; i < data.length; i += 4) {
        data[i] = (Math.random() - 0.5) * 500;     // X
        data[i + 1] = (Math.random() - 0.5) * 500; // Y
        data[i + 2] = 0;                           // Z
        data[i + 3] = Math.random();               // Life
      }
    }

    const posVar = gpuCompute.addVariable('texturePosition', positionFragmentShader, dtPosition);
    gpuCompute.setVariableDependencies(posVar, [posVar]);
    
    // --- INITIALIZE UNIFORMS TO PREVENT CRASH ---
    // These must be set before the first render loop
    posVar.material.uniforms.time = { value: 0 };
    posVar.material.uniforms.audioBass = { value: 0 };
    posVar.material.uniforms.audioMid = { value: 0 };
    posVar.material.uniforms.audioTreble = { value: 0 };
    posVar.material.uniforms.audioLevel = { value: 0 };
    posVar.material.uniforms.audioTransient = { value: 0 };
    posVar.material.uniforms.uCurlStrength = { value: 0 };
    posVar.material.uniforms.uTimeStep = { value: 1.0 };
    posVar.material.uniforms.uNoiseScale = { value: 0 };
    posVar.material.uniforms.uFlowSpeed = { value: 1.0 };
    posVar.material.uniforms.uCurlInfluence = { value: 1.0 };
    posVar.material.uniforms.uAudioReactivity = { value: 1.0 };
    posVar.material.uniforms.uResolution = { value: new THREE.Vector2(TEXTURE_SIZE, TEXTURE_SIZE) };
    
    const error = gpuCompute.init();
    if (error !== null) {
      console.error('GPUComputationRenderer init error:', error);
      return { geometry: new THREE.BufferGeometry() };
    }

    gpuComputeRef.current = gpuCompute;
    positionVariableRef.current = posVar;

    // 2. Setup Render Geometry (References to Texture Pixels)
    const geom = new THREE.BufferGeometry();
    const references = new Float32Array(particleCount * 2);
    const sizes = new Float32Array(particleCount);

    for (let i = 0; i < particleCount; i++) {
      const x = (i % TEXTURE_SIZE) / TEXTURE_SIZE;
      const y = Math.floor(i / TEXTURE_SIZE) / TEXTURE_SIZE;
      references[i * 2] = x;
      references[i * 2 + 1] = y;
      sizes[i] = 1.0 + Math.random();
    }

    geom.setAttribute('reference', new THREE.BufferAttribute(references, 2));
    geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1000);

    return { geometry: geom };
  }, [gl, particleCount]);

  useFrame((state) => {
    if (!gpuComputeRef.current || !positionVariableRef.current) return;

    // 1. Update Physics Uniforms
    const computeMat = positionVariableRef.current.material;
    
    // Now these values exist, so they won't crash
    computeMat.uniforms.time.value = state.clock.elapsedTime;
    computeMat.uniforms.audioLevel.value = audioData.level;
    computeMat.uniforms.audioBass.value = audioData.bass;
    computeMat.uniforms.audioTreble.value = audioData.treble;
    computeMat.uniforms.uFlowSpeed.value = controls.flowSpeed;
    computeMat.uniforms.uCurlInfluence.value = controls.curlInfluence;
    computeMat.uniforms.uNoiseScale.value = controls.noiseScale;
    computeMat.uniforms.uResolution.value.set(TEXTURE_SIZE, TEXTURE_SIZE);

    // 2. Run Physics
    gpuComputeRef.current.compute();

    // 3. Update Render Material Uniforms
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
          uTexturePosition: { value: null },
          uParticleSize: { value: 2.0 },
          uPixelRatio: { value: gl.getPixelRatio() }
        }}
        transparent={true}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
}
