-- TSDROP on Omarchy.
--
-- Hyprland decides where windows go, so the popup placement the app does on
-- Windows and X11 is this file's job here. Installed to ~/.config/hypr/tsdrop.lua
-- by omarchy/install.sh, which also adds require("hypr.tsdrop") to hyprland.lua.

-- A HUD, not a tile. No size: the app asks for the size it remembers, and
-- Hyprland honours that for a floating window. Opacity is left alone on
-- purpose, so TSDROP fades with every other Omarchy window.
o.window("tsdrop", {
  float = true,
  move = { "(monitor_w-window_w-20)", "(monitor_h-window_h-20)" },
})

-- Wayland hands hotkeys to the compositor, not to the app, so the global
-- Ctrl+Insert of the Windows and X11 builds is a Hyprland binding here.
-- Running `tsdrop` while it is already running shows or hides the window.
--
-- Not Ctrl+Insert: Omarchy sends that to terminals as copy (SUPER + C), and
-- terminals have meant it as copy since long before that. Change the chord
-- here if Super+Insert is in your way.
o.bind("SUPER + INSERT", "TSDROP", "tsdrop")
