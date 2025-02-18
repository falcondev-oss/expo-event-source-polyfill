# Expo EventSource polyfill

This package provides a polyfill for the EventSource API in Expo using `expo/fetch`. By using Expo's fetch implementation we don't rely on polling as a workaround since it supports streaming out of the box.

> [!WARNING]
> Only works with Expo v52 and above.

## Installation

```bash
npm install @falcondev-oss/expo-event-source-polyfill
```

## Usage

Create an `index.js` file in the root of your project with the following content:

```javascript
// @ts-expect-error this is used internally and the recommended way to polyfill global objects
import { polyfillGlobal } from 'react-native/Libraries/Utilities/PolyfillFunctions'
import { ExpoEventSource } from '@falcondev-oss/expo-event-source-polyfill'

polyfillGlobal('EventSource', () => ExpoEventSource)

import 'expo-router/entry'
```

Then, add the following to your `package.json`:

```json
{
  "main": "index.js"
}
```