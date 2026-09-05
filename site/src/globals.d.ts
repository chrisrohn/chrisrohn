// Third-party globals loaded at runtime: Google Identity Services and the YouTube IFrame Player API.
declare const google: any;
declare const YT: any;
interface Window { onYouTubeIframeAPIReady?: () => void; google?: any; YT?: any }
