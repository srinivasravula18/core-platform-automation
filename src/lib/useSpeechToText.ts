import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechToTextOptions = {
  lang?: string;
  onTranscript: (transcript: string) => void;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: any) => void) | null;
};

function getSpeechRecognitionConstructor() {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

function getSpeechErrorMessage(error: string) {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is blocked. Allow microphone permission in the browser and try again.';
    case 'no-speech':
      return 'No speech was detected. Try speaking closer to the microphone.';
    case 'audio-capture':
      return 'No microphone was found. Connect or enable a microphone and try again.';
    case 'network':
      return 'Speech recognition needs a network connection in this browser.';
    default:
      return 'Speech recognition stopped unexpectedly. Try again.';
  }
}

export function useSpeechToText({ lang = 'en-US', onTranscript }: SpeechToTextOptions) {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState('');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const shouldListenRef = useRef(false);
  const startingRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    const SpeechRecognition = getSpeechRecognitionConstructor();
    if (!SpeechRecognition) {
      setIsSupported(false);
      setError('Speech recognition is not supported in this browser. Use Chrome or Edge for voice input.');
      return;
    }

    setIsSupported(true);
    const recognition = new SpeechRecognition() as SpeechRecognitionLike;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      startingRef.current = false;
      setIsListening(true);
      setError('');
    };

    recognition.onresult = (event: any) => {
      let finalText = '';
      let interimText = '';

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0]?.transcript || '';
        if (event.results[index].isFinal) {
          finalText += transcript;
        } else {
          interimText += transcript;
        }
      }

      if (finalText.trim()) {
        onTranscriptRef.current(finalText.trim());
      }

      setInterimTranscript(interimText.trim());
    };

    recognition.onerror = (event) => {
      startingRef.current = false;
      setIsListening(false);
      setInterimTranscript('');
      setError(getSpeechErrorMessage(event.error));

      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        shouldListenRef.current = false;
      }
    };

    recognition.onend = () => {
      startingRef.current = false;
      setIsListening(false);
      setInterimTranscript('');

      if (shouldListenRef.current) {
        window.setTimeout(() => {
          if (!shouldListenRef.current || startingRef.current) return;
          try {
            startingRef.current = true;
            recognition.start();
          } catch {
            startingRef.current = false;
          }
        }, 250);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      shouldListenRef.current = false;
      recognitionRef.current = null;
      recognition.abort();
    };
  }, [lang]);

  const startListening = useCallback(async () => {
    if (!recognitionRef.current || startingRef.current) return;

    setError('');

    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        setError('Microphone permission was denied or no microphone is available.');
        return;
      }
    }

    shouldListenRef.current = true;
    startingRef.current = true;

    try {
      recognitionRef.current.start();
    } catch {
      startingRef.current = false;
      setError('Speech recognition is already starting. Try again in a moment.');
    }
  }, []);

  const stopListening = useCallback(() => {
    shouldListenRef.current = false;
    startingRef.current = false;
    setIsListening(false);
    setInterimTranscript('');
    recognitionRef.current?.stop();
  }, []);

  const toggleListening = useCallback(() => {
    if (shouldListenRef.current || isListening) {
      stopListening();
    } else {
      void startListening();
    }
  }, [isListening, startListening, stopListening]);

  return {
    error,
    interimTranscript,
    isListening,
    isSupported,
    startListening,
    stopListening,
    toggleListening,
  };
}
