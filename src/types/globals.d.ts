declare const jsmediatags: any;
declare const YT: any;
declare var webkitSpeechRecognition: any;
declare var SpeechRecognition: any;

interface Window {
  __aura?: any;
  YT?: any;
  auraMini?: any;
  [key: string]: any;
}

interface EventTarget {
  [key: string]: any;
}

interface Navigator {
  mozConnection?: any;
  connection?: any;
  deviceMemory?: any;
  speechSynthesis?: SpeechSynthesis;
}

interface HTMLMediaElement {
  captureStream?: any;
  mozCaptureStream?: any;
}
