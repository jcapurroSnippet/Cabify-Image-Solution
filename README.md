# Cabify Image Suite

Single Vite + React app that combines two image workflows in separate tabs:

- `Nano Editor`: prompt-driven image editing with strict Cabify constraints.
- `Aspect Ratio`: generates `1:1` and `9:16` variants from one source image.

## Requirements

- Node.js 20+
- Gemini API key

## Setup

1. Install dependencies:
   `npm install`
2. Configure environment variable in `.env`:
   `VITE_GEMINI_API_KEY=YOUR_GEMINI_API_KEY`
3. Start development server:
   `npm run dev`

## Scripts

- `npm run dev` - start local development server
- `npm run build` - production build
- `npm run preview` - preview production build
- `npm run lint` - type check