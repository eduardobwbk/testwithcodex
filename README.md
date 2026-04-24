# Video Hand & Audio Reactive Playhead

Browser-based performance tool prototype for hand-controlled and audio-reactive video scrubbing.

## Features in this implementation

- Video upload + canvas-based render path.
- Audio envelope analysis from mic or uploaded audio file.
- Playhead modes: position, velocity, and segment-roam.
- Two-hand semantics scaffolded (left: playhead, right: blob gestures).
- Canvas frame-difference blob tracker with style cycling.
- Physics momentum layer for inertia and frequency-driven impulses.
- Parameter-heavy control panel with real-time sliders.

## Running

```bash
npm install
npm run dev
```

> Note: In this environment, package installation may be restricted. The code is structured for a normal Vite + React + TypeScript setup.

## Next integration points

- Replace `useHandTracking` simulation fallback with MediaPipe Hands/HandLandmarker inference.
- Add OpenCV.js contour extraction for more robust blob boundaries.
- Migrate simple inline styles to Tailwind/shadcn or custom design system.
