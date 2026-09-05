// Third-party globals loaded at runtime: Google Identity Services and the YouTube IFrame Player API.
declare const google: any;
declare const YT: any;
interface Window { onYouTubeIframeAPIReady?: () => void; google?: any; YT?: any }
// Chromium's install prompt (not in lib.dom) and Safari's standalone flag
interface BeforeInstallPromptEvent extends Event { readonly platforms: string[]; readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>; prompt(): Promise<void> }
interface WindowEventMap { beforeinstallprompt: BeforeInstallPromptEvent; appinstalled: Event }
interface Navigator { standalone?: boolean }
