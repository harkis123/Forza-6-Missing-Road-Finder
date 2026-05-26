// GPU pipeline for the Forza Map Finder.
//
// Instead of iterating pixels on the CPU, we render the source frame onto a
// full-screen quad and run a fragment shader that:
//   1. samples the source texture,
//   2. computes a weighted Euclidean distance to the "find" colour in linear
//      sRGB space (this is closer to perceived colour difference than a
//      per-channel L∞ check),
//   3. emits either the replacement colour, a desaturated version, or the
//      original pixel.
//
// One shader pass replaces an entire frame regardless of resolution — 4K
// screenshots are handled in a couple of milliseconds on integrated graphics.

const VERTEX_SHADER = `#version 300 es
in vec2 a_clipPos;
out vec2 v_texCoord;

void main() {
  // Map clip-space [-1,1] to texture [0,1] and flip Y so the source image
  // appears the right way up (textures are bottom-origin, images are top).
  v_texCoord = vec2(a_clipPos.x * 0.5 + 0.5, 0.5 - a_clipPos.y * 0.5);
  gl_Position = vec4(a_clipPos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_source;
uniform vec3      u_find;        // target colour, linear sRGB, 0..1
uniform vec3      u_paint;       // replacement colour, linear sRGB, 0..1
uniform float     u_distanceMax; // squared weighted distance below which a pixel matches
uniform float     u_desaturate;  // 0 = pass through, 1 = greyscale background

in  vec2 v_texCoord;
out vec4 outColor;

// sRGB → linear (approximate, fast).
vec3 srgbToLinear(vec3 c) {
  return c * c;
}
// linear → sRGB
vec3 linearToSrgb(vec3 c) {
  return sqrt(c);
}

// Weighted Euclidean squared distance.
// The luma weights (Rec. 601) emphasise green where the eye is most sensitive
// and suppress blue where it isn't — perceptually a bit nicer than raw RGB
// distance.
float weightedDistanceSq(vec3 a, vec3 b) {
  vec3 diff = a - b;
  vec3 weights = vec3(0.299, 0.587, 0.114);
  return dot(diff * diff, weights);
}

void main() {
  vec3 srgbSample = texture(u_source, v_texCoord).rgb;
  vec3 linearSample = srgbToLinear(srgbSample);
  vec3 linearFind   = srgbToLinear(u_find);

  float d2 = weightedDistanceSq(linearSample, linearFind);

  vec3 result;
  if (d2 <= u_distanceMax) {
    result = u_paint;
  } else if (u_desaturate > 0.5) {
    float luma = dot(srgbSample, vec3(0.299, 0.587, 0.114));
    result = vec3(luma);
  } else {
    result = srgbSample;
  }

  outColor = vec4(result, 1.0);
}
`;

// Two triangles covering the entire clip space.
const QUAD_VERTICES = new Float32Array([
  -1.0, -1.0,
   3.0, -1.0,   // big triangle trick: one triangle that covers the screen
  -1.0,  3.0,
]);

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed:\n${info}`);
  }
  return shader;
}

function linkProgram(gl, vsSource, fsSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed:\n${info}`);
  }
  return program;
}

export class MapHighlighter {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha:                 false,
      antialias:             false,
      depth:                 false,
      stencil:               false,
      premultipliedAlpha:    false,
      preserveDrawingBuffer: true,   // needed so canvas.toBlob() can read the output
    });
    if (!gl) {
      throw new Error('WebGL2 is required (your browser does not expose it).');
    }

    this.canvas = canvas;
    this.gl     = gl;
    this.hasSource = false;

    this._program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this._loc = {
      find:        gl.getUniformLocation(this._program, 'u_find'),
      paint:       gl.getUniformLocation(this._program, 'u_paint'),
      distanceMax: gl.getUniformLocation(this._program, 'u_distanceMax'),
      desaturate:  gl.getUniformLocation(this._program, 'u_desaturate'),
      source:      gl.getUniformLocation(this._program, 'u_source'),
    };

    // Static VBO + VAO for the cover quad.
    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);
    const aClipPos = gl.getAttribLocation(this._program, 'a_clipPos');
    gl.enableVertexAttribArray(aClipPos);
    gl.vertexAttribPointer(aClipPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Texture object reused across uploads.
    this._texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,            false);
  }

  // Match the canvas size (and the GL viewport) to whatever source we just
  // received. This must be called *before* upload() / render() if the
  // dimensions changed.
  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width  = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  }

  // Upload a frame source — HTMLVideoElement, HTMLImageElement, ImageBitmap or
  // HTMLCanvasElement. WebGL handles the format conversion internally.
  upload(source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.hasSource = true;
  }

  // params:
  //   findColor    [r, g, b] in 0..1
  //   paintColor   [r, g, b] in 0..1
  //   tolerance255 the same 0..40 value the UI exposes (per-channel intent)
  //   desaturate   boolean
  render(params) {
    const gl = this.gl;
    if (!this.hasSource) return;

    // Convert UI tolerance (per-channel max deviation, 0..40 out of 255) to a
    // squared weighted distance. With weights summing to 1 the worst-case
    // weighted distance for an across-the-board ±tol/255 shift is tol/255, so
    // we square that with a small safety margin.
    const linearTol = params.tolerance255 / 255;
    const distanceMax = linearTol * linearTol * 3.0;

    gl.useProgram(this._program);
    gl.bindVertexArray(this._vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.uniform1i(this._loc.source, 0);

    gl.uniform3f(this._loc.find,
      params.findColor[0],  params.findColor[1],  params.findColor[2]);
    gl.uniform3f(this._loc.paint,
      params.paintColor[0], params.paintColor[1], params.paintColor[2]);
    gl.uniform1f(this._loc.distanceMax, distanceMax);
    gl.uniform1f(this._loc.desaturate,  params.desaturate ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteTexture(this._texture);
    gl.deleteVertexArray(this._vao);
    gl.deleteProgram(this._program);
  }
}

// Parse "#rrggbb" into a normalised [r, g, b] tuple in 0..1.
// Returns null if the string isn't a valid hex colour.
export function parseHexColor(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const packed = parseInt(match[1], 16);
  return [
    ((packed >> 16) & 0xff) / 255,
    ((packed >>  8) & 0xff) / 255,
    ( packed        & 0xff) / 255,
  ];
}
