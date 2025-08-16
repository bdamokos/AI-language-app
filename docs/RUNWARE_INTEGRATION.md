# Runware Integration Guide

This document explains how to use the Runware text-to-image generation integration in the Language AI App.

## Overview

The Runware integration provides AI-powered text-to-image generation capabilities through the `useRunware` hook. This allows the application to generate images from text prompts using Runware's API.

## Setup

### 1. Environment Variables

Add the following environment variables to your `.env` file:

```env
# Runware Configuration
RUNWARE_API_KEY=your_runware_api_key_here
RUNWARE_MODEL=runware:100@1
RUNWARE_ENABLED=true
RUNWARE_WIDTH=512
RUNWARE_HEIGHT=512
RUNWARE_STEPS=20
RUNWARE_CFG_SCALE=7
```

### 2. Get API Key

1. Sign up at [Runware Dashboard](https://my.runware.ai/signup)
2. Obtain your API key from the dashboard
3. Add it to your `.env` file as `RUNWARE_API_KEY`

## Usage

### Basic Implementation

```jsx
import useRunware from '../hooks/useRunware';

function MyComponent() {
  const { generateImage, loading, error, imageData, clear } = useRunware();

  const handleGenerate = async () => {
    try {
      const result = await generateImage("A beautiful sunset over mountains");
      console.log('Generated image:', result);
    } catch (err) {
      console.error('Generation failed:', err);
    }
  };

  return (
    <div>
      <button onClick={handleGenerate} disabled={loading}>
        {loading ? 'Generating...' : 'Generate Image'}
      </button>
      
      {error && <p className="text-red-600">Error: {error}</p>}
      
      {imageData && (
        <div>
          <img src={imageData.data[0]?.imageSrc} alt="Generated" />
          <button onClick={clear}>Clear</button>
        </div>
      )}
    </div>
  );
}
```

### Advanced Options

```jsx
const result = await generateImage("A cyberpunk city at night", {
  model: "runware:100@1",
  width: 768,
  height: 512,
  steps: 30,
  cfgScale: 8,
  seed: 42,
  scheduler: "DPM++ 2M Karras"
});
```

## Hook API Reference

### `useRunware()`

Returns an object with the following properties and methods:

#### State Properties

- **`loading: boolean`** - Whether an image generation is in progress
- **`error: string | null`** - Error message if generation failed
- **`imageData: object | null`** - Generated image data from the API

#### Methods

- **`generateImage(prompt, options?): Promise<object>`**
  - Generates an image from a text prompt
  - **Parameters:**
    - `prompt: string` - Text description for image generation (required)
    - `options?: object` - Optional generation parameters
      - `model?: string` - Model to use (defaults to configured model)
      - `width?: number` - Image width, must be divisible by 64 (default: 512)
      - `height?: number` - Image height, must be divisible by 64 (default: 512)
      - `steps?: number` - Number of generation steps (default: 20)
      - `cfgScale?: number` - Classifier-free guidance scale (default: 7)
      - `seed?: number` - Seed for reproducible generation
      - `scheduler?: string` - Scheduler algorithm to use
  - **Returns:** Promise resolving to image data object
  - **Throws:** Error if generation fails

- **`clear(): void`**
  - Clears stored image data and errors

- **`getModels(): Promise<Array>`**
  - Fetches available models from Runware
  - **Returns:** Promise resolving to array of model objects

## Settings Panel Integration

The Runware settings are automatically available in the Settings Panel with the following controls:

- **Enable/Disable Toggle** - Turn image generation on/off
- **API Key** - Secure input for Runware API key (shown when "Show API keys" is enabled)
- **Model Selection** - Choose from available Runware models
- **Generation Parameters:**
  - Width/Height (64-2048px, must be divisible by 64)
  - Steps (1-100)
  - CFG Scale (1-20)

## API Endpoints

The integration provides the following backend endpoints:

### `POST /api/runware/generate`

Generates an image from a text prompt.

**Request Body:**
```json
{
  "prompt": "A beautiful landscape",
  "model": "runware:100@1",
  "width": 512,
  "height": 512,
  "steps": 20,
  "cfgScale": 7,
  "seed": 42,
  "scheduler": "DPM++ 2M Karras"
}
```

**Response:**
```json
{
  "taskUUID": "task-1234567890-abc123",
  "success": true,
  "data": [
    {
      "imageSrc": "data:image/png;base64,iVBORw0KGgoAAAANS...",
      "imageUUID": "img-uuid-here",
      "cost": 0.001
    }
  ]
}
```

### `GET /api/runware/models`

Fetches available models from Runware.

**Response:**
```json
{
  "models": [
    {
      "id": "runware:100@1",
      "name": "Stable Diffusion v1.5",
      "type": "base"
    }
  ]
}
```

## Error Handling

The hook provides comprehensive error handling:

```jsx
const { generateImage, error } = useRunware();

try {
  await generateImage("test prompt");
} catch (err) {
  // Handle specific errors
  if (err.message.includes('API key')) {
    console.error('Invalid or missing API key');
  } else if (err.message.includes('HTTP 429')) {
    console.error('Rate limit exceeded');
  } else {
    console.error('Generation failed:', err.message);
  }
}
```

## Common Use Cases

### 1. Educational Content Generation

Generate visual aids for language learning:

```jsx
const generateEducationalImage = async (topic) => {
  const prompt = `Educational illustration of ${topic}, clean simple style, suitable for language learning`;
  return await generateImage(prompt, {
    width: 512,
    height: 512,
    steps: 25
  });
};
```

### 2. Exercise Enhancement

Create visual context for exercises:

```jsx
const enhanceExercise = async (exerciseText) => {
  const prompt = `Illustration depicting: ${exerciseText}, educational style, clear and simple`;
  return await generateImage(prompt);
};
```

### 3. Custom Vocabulary Cards

Generate images for vocabulary items:

```jsx
const generateVocabImage = async (word, context) => {
  const prompt = `Simple illustration of ${word} in context: ${context}`;
  return await generateImage(prompt, {
    width: 256,
    height: 256,
    steps: 15
  });
};
```

## Best Practices

1. **Prompt Engineering:** Write clear, descriptive prompts for better results
2. **Resource Management:** Use `clear()` to free memory when images are no longer needed
3. **Error Handling:** Always wrap `generateImage()` calls in try-catch blocks
4. **Performance:** Consider caching generated images for frequently used prompts
5. **User Experience:** Show loading states and progress indicators during generation

## Troubleshooting

### Common Issues

1. **"Missing RUNWARE_API_KEY" Error**
   - Ensure your API key is properly set in the `.env` file
   - Verify the key is valid by checking the Runware dashboard

2. **"Runware image generation is disabled" Error**
   - Check that `RUNWARE_ENABLED=true` in your environment
   - Enable image generation in the Settings Panel

3. **Generation Timeouts**
   - Try reducing the number of steps
   - Check your internet connection
   - Verify Runware service status

4. **Invalid Dimensions Error**
   - Ensure width and height are divisible by 64
   - Keep dimensions within the 64-2048 range

### Debug Information

Enable debug logging by checking the browser console and server logs:

```bash
# Server logs will show:
[RUNWARE] Generating image with model=runware:100@1 size=512x512 steps=20
[RUNWARE] Generation completed for task task-1234567890-abc123
```

## Architecture Notes

The Runware integration follows the same patterns as other providers in the codebase:

- **Runtime Configuration:** Settings can be updated without server restart
- **Centralized API Handling:** All Runware API calls go through the backend
- **Error Propagation:** Detailed error messages are passed through to the frontend
- **Environment Persistence:** Settings are automatically saved to `.env` file

## Security Considerations

- API keys are never exposed to the frontend
- All API calls are proxied through the backend
- Generated images are returned as data URLs for immediate use
- No permanent storage of generated images by default

---

For more information about Runware's capabilities, visit the [Runware Documentation](https://runware.ai/docs/).