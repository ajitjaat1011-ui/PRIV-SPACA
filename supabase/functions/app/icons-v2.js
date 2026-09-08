/*! PRIV SPACA — Icon Set v2 override layer
    Swaps mapped Lucide icons for the custom v2 set (outline + filled + micro-animations).
    Non-invasive: does not modify app.min.js. Unmapped icons stay Lucide. */
(function(){'use strict';
if(window.__PSV2__)return;window.__PSV2__=true;

var ICONS={"Home":{"cls":"a-home","anim":"cell wave","outline":"<rect class=\"hc\" x=\"3.5\" y=\"3.5\" width=\"7.4\" height=\"7.4\" rx=\"2.4\"/><rect class=\"hc c2\" x=\"13.1\" y=\"3.5\" width=\"7.4\" height=\"7.4\" rx=\"2.4\"/><rect class=\"hc c3\" x=\"3.5\" y=\"13.1\" width=\"7.4\" height=\"7.4\" rx=\"2.4\"/><rect class=\"hc c4\" x=\"13.1\" y=\"13.1\" width=\"7.4\" height=\"7.4\" rx=\"2.4\"/>","filled":"<rect x=\"3.5\" y=\"3.5\" width=\"7.4\" height=\"7.4\" rx=\"2.4\"/><rect x=\"13.1\" y=\"3.5\" width=\"7.4\" height=\"7.4\" rx=\"2.4\"/><rect x=\"3.5\" y=\"13.1\" width=\"7.4\" height=\"7.4\" rx=\"2.4\"/><rect x=\"13.1\" y=\"13.1\" width=\"7.4\" height=\"7.4\" rx=\"2.4\"/>"},"Search":{"cls":"a-search","anim":"comet scan","outline":"<circle class=\"lens\" cx=\"11\" cy=\"11\" r=\"6.8\"/><path d=\"M15.9 15.9l4.9 4.9\"/>","filled":"<circle cx=\"11\" cy=\"11\" r=\"7.4\"/><path class=\"st\" d=\"M16 16l5 5\" stroke-width=\"3\"/>"},"Create":{"cls":"a-create","anim":"plus spin","outline":"<rect x=\"3.5\" y=\"3.5\" width=\"17\" height=\"17\" rx=\"5\"/><path class=\"plus\" d=\"M12 8.2v7.6M8.2 12h7.6\"/>","filled":"<path fill-rule=\"evenodd\" d=\"M8 3.5h8c2.49 0 4.5 2.01 4.5 4.5v8c0 2.49-2.01 4.5-4.5 4.5H8C5.51 20.5 3.5 18.49 3.5 16V8c0-2.49 2.01-4.5 4.5-4.5Zm2.8 4c-.44 0-.8.36-.8.8v2.7H7.3c-.44 0-.8.36-.8.8v1.4c0 .44.36.8.8.8h2.7v2.7c0 .44.36.8.8.8h1.4c.44 0 .8-.36.8-.8v-2.7h2.7c.44 0 .8-.36.8-.8v-1.4c0-.44-.36-.8-.8-.8h-2.7V8.3c0-.44-.36-.8-.8-.8h-1.4Z\"/>"},"Reels":{"cls":"a-reels","anim":"play pulse","outline":"<rect x=\"3.5\" y=\"3.5\" width=\"17\" height=\"17\" rx=\"5\"/><path class=\"tri\" d=\"M10.3 9.2l4.5 2.8-4.5 2.8z\"/>","filled":"<path fill-rule=\"evenodd\" d=\"M8 3.5h8c2.49 0 4.5 2.01 4.5 4.5v8c0 2.49-2.01 4.5-4.5 4.5H8C5.51 20.5 3.5 18.49 3.5 16V8c0-2.49 2.01-4.5 4.5-4.5Zm2.3 5.6c0-.85.92-1.36 1.63-.9l4.3 2.5c.7.4.7 1.4 0 1.8l-4.3 2.5c-.71.4-1.63-.1-1.63-.9Z\"/>"},"Inbox":{"cls":"a-inbox","anim":"msg bounce","outline":"<path class=\"bub\" d=\"M6 4.5h12c1.4 0 2.5 1.1 2.5 2.5v7.5c0 1.4-1.1 2.5-2.5 2.5H10l-3.9 3a.9.9 0 0 1-1.4-.7V17H6c-1.4 0-2.5-1.1-2.5-2.5V7c0-1.4 1.1-2.5 2.5-2.5Z\"/><circle class=\"id\" cx=\"8.2\" cy=\"10.8\" r=\".95\"/><circle class=\"id d2\" cx=\"12\" cy=\"10.8\" r=\".95\"/><circle class=\"id d3\" cx=\"15.8\" cy=\"10.8\" r=\".95\"/>","filled":"<path d=\"M6 4.5h12c1.4 0 2.5 1.1 2.5 2.5v7.5c0 1.4-1.1 2.5-2.5 2.5H10l-3.9 3a.9.9 0 0 1-1.4-.7V17H6c-1.4 0-2.5-1.1-2.5-2.5V7c0-1.4 1.1-2.5 2.5-2.5Z\"/>"},"Bell":{"cls":"a-bell","anim":"ring swing","outline":"<path class=\"bbody\" d=\"M6.4 15.7v-4.5a5.6 5.6 0 0 1 11.2 0v4.5l1.7 2.6c.3.5 0 1.2-.7 1.2H5.4c-.7 0-1-.7-.7-1.2l1.7-2.6Z\"/><path class=\"bclap\" d=\"M10.1 20.9a2 2 0 0 0 3.8 0\"/>","filled":"<path d=\"M6.4 15.7v-4.5a5.6 5.6 0 0 1 11.2 0v4.5l1.7 2.6c.3.5 0 1.2-.7 1.2H5.4c-.7 0-1-.7-.7-1.2l1.7-2.6Z\"/><path d=\"M9.9 20.4a2.1 2.1 0 0 0 4.2 0Z\"/>"},"Like":{"cls":"a-heart","anim":"heartbeat","outline":"<path class=\"hb\" d=\"M12 20.3C7 16.7 3.6 13.3 3.6 9.9 3.6 7.2 5.6 5.1 8.1 5.1c1.7 0 3.1.9 3.9 2.3.8-1.4 2.2-2.3 3.9-2.3 2.5 0 4.5 2.1 4.5 4.8 0 3.4-3.4 6.8-8.4 10.4Z\"/><path class=\"hsp\" d=\"M19 2.9l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z\" fill=\"var(--ink)\" stroke=\"none\"/>","filled":"<path d=\"M12 20.3C7 16.7 3.6 13.3 3.6 9.9 3.6 7.2 5.6 5.1 8.1 5.1c1.7 0 3.1.9 3.9 2.3.8-1.4 2.2-2.3 3.9-2.3 2.5 0 4.5 2.1 4.5 4.8 0 3.4-3.4 6.8-8.4 10.4Z\"/>"},"Comment":{"cls":"a-comment","anim":"typing dots","outline":"<path class=\"cbub\" d=\"M12 3.8c5 0 9 3.4 9 7.7s-4 7.7-9 7.7c-1 0-2-.1-2.9-.4L5 19.8l1-3.2c-1.3-1.4-2-3.2-2-5.1 0-4.3 4-7.7 8-7.7Z\"/><circle class=\"id\" cx=\"8.4\" cy=\"11.5\" r=\"1.05\"/><circle class=\"id d2\" cx=\"12\" cy=\"11.5\" r=\"1.05\"/><circle class=\"id d3\" cx=\"15.6\" cy=\"11.5\" r=\"1.05\"/>","filled":"<path fill-rule=\"evenodd\" d=\"M12 3.8c5 0 9 3.4 9 7.7s-4 7.7-9 7.7c-1 0-2-.1-2.9-.4L5 19.8l1-3.2c-1.3-1.4-2-3.2-2-5.1 0-4.3 4-7.7 8-7.7ZM7.4 11.5a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 1 0-2.4 0Zm3.4 0a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 1 0-2.4 0Zm3.4 0a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 1 0-2.4 0Z\"/>"},"Share":{"cls":"a-share","anim":"paper flight","outline":"<path class=\"trail\" d=\"M4.2 19.8c2.8.4 4.6-.4 6.4-2.2\" stroke-dasharray=\"2.4 3\" stroke-opacity=\".55\"/><path class=\"plane\" d=\"M20.9 3.9L6.4 9.4c-1 .35-.95 1.75.05 2.05l4.55 1.25c.35.1.65.4.75.75l1.25 4.55c.3 1 1.7.95 2.05-.05L20.9 3.9Z\"/>","filled":"<path d=\"M20.9 3.9L6.4 9.4c-1 .35-.95 1.75.05 2.05l4.55 1.25c.35.1.65.4.75.75l1.25 4.55c.3 1 1.7.95 2.05-.05L20.9 3.9Z\"/>"},"Save":{"cls":"a-bookmark","anim":"drop in","outline":"<path class=\"bm\" d=\"M6.8 3.5h10.4c.5 0 .9.4.9.9v15.8c0 .7-.8 1.1-1.4.7L12 17.3l-4.7 3.6c-.6.4-1.4 0-1.4-.7V4.4c0-.5.4-.9.9-.9Z\"/>","filled":"<path d=\"M6.8 3.5h10.4c.5 0 .9.4.9.9v15.8c0 .7-.8 1.1-1.4.7L12 17.3l-4.7 3.6c-.6.4-1.4 0-1.4-.7V4.4c0-.5.4-.9.9-.9Z\"/>"},"Camera":{"cls":"a-cam","anim":"flash blink","outline":"<path d=\"M3.5 9.2c0-1.2 1-2.2 2.2-2.2h1.7L9 4.5h6l1.6 2.5h1.7c1.2 0 2.2 1 2.2 2.2v7.8c0 1.2-1 2.2-2.2 2.2H5.7c-1.2 0-2.2-1-2.2-2.2V9.2Z\"/><circle class=\"clens\" cx=\"12\" cy=\"12.8\" r=\"3.6\"/><path class=\"cfl\" d=\"M19.7 2.6l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z\" fill=\"var(--ink)\" stroke=\"none\"/>","filled":"<path fill-rule=\"evenodd\" d=\"M5.7 7c-1.2 0-2.2 1-2.2 2.2v7.8c0 1.2 1 2.2 2.2 2.2h12.6c1.2 0 2.2-1 2.2-2.2V9.2c0-1.2-1-2.2-2.2-2.2h-1.7L15 4.5H9l-1.6 2.5H5.7Zm6.3 3.5a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 1 0 0-7.2Zm0 1.9a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 1 1 0-3.4Z\"/>"},"Profile":{"cls":"a-profile","anim":"head bob","outline":"<circle class=\"phead\" cx=\"12\" cy=\"7.8\" r=\"4.1\"/><path d=\"M4.6 20.1c.9-3.6 3.8-5.7 7.4-5.7s6.5 2.1 7.4 5.7\"/>","filled":"<circle cx=\"12\" cy=\"7.4\" r=\"4.4\"/><path d=\"M12 12.8c-3.8 0-6.9 2.3-7.8 6-.2.7.3 1.4 1 1.4h13.6c.7 0 1.2-.7 1-1.4-.9-3.7-4-6-7.8-6Z\"/>"},"Lock":{"cls":"a-lock","anim":"shackle slam","outline":"<path class=\"lshk\" d=\"M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5\"/><rect x=\"5.3\" y=\"10.5\" width=\"13.4\" height=\"10\" rx=\"3\"/><circle class=\"lkho\" cx=\"12\" cy=\"14.6\" r=\"1.15\" fill=\"var(--ink)\" stroke=\"none\"/>","filled":"<path class=\"st\" d=\"M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5\" stroke-width=\"2.6\"/><path fill-rule=\"evenodd\" d=\"M7.8 10.5h8.4a3 3 0 0 1 3 3v4.2a3 3 0 0 1-3 3H7.8a3 3 0 0 1-3-3v-4.2a3 3 0 0 1 3-3Zm4.2 2.5a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 1 0 0-3.8Zm-.7 2.9-.8 3.1h3.4l-.8-3.1Z\"/>"},"Shield":{"cls":"a-shield","anim":"check draw","outline":"<path d=\"M12 3.2l7.3 2.7v5.5c0 5-3.1 8.3-7.3 10-4.2-1.7-7.3-5-7.3-10V5.9l7.3-2.7Z\"/><path class=\"schk\" d=\"M8.9 12.7l2.3 2.3 4.7-5.2\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"2\"/>","filled":"<path fill-rule=\"evenodd\" d=\"M12 3.2l7.3 2.7v5.5c0 5-3.1 8.3-7.3 10-4.2-1.7-7.3-5-7.3-10V5.9l7.3-2.7Zm-3.1 9.5 2.3 2.3 4.7-5.2-1.5-1.4-3.3 3.6-.8-.7Z\"/>"},"Hidden":{"cls":"a-eye","anim":"blink + slash","outline":"<g class=\"eyeg\"><path d=\"M2.5 12C5 7.5 8.2 5.5 12 5.5s6.8 2 9.5 6.5c-2.7 4.5-5.9 6.5-9.5 6.5S5 16.5 2.5 12Z\"/><circle cx=\"12\" cy=\"12\" r=\"3.1\"/></g><path class=\"eslash\" d=\"M4 4l16 16\"/>","filled":"<path fill-rule=\"evenodd\" d=\"M2.4 12C5 7.4 8.2 5.3 12 5.3S19 7.4 21.6 12C19 16.6 15.8 18.7 12 18.7S5 16.6 2.4 12ZM8.8 6.2L17.8 15.2 15.2 17.8 6.2 8.8Z\"/>"},"Burns":{"cls":"a-hour","anim":"hourglass flip","outline":"<g class=\"hg\"><path d=\"M6.5 3.5h11M6.5 20.5h11\"/><path d=\"M8.2 3.5c0 4.7 3.8 5.7 3.8 8.5s-3.8 3.8-3.8 8.5M15.8 3.5c0 4.7-3.8 5.7-3.8 8.5s3.8 3.8 3.8 8.5\"/></g><circle class=\"grain\" cx=\"12\" cy=\"9.5\" r=\".9\" fill=\"var(--ink)\" stroke=\"none\"/>","filled":"<rect x=\"5.6\" y=\"2.8\" width=\"12.8\" height=\"1.9\" rx=\".95\"/><rect x=\"5.6\" y=\"19.3\" width=\"12.8\" height=\"1.9\" rx=\".95\"/><path d=\"M7 4.7h10v1.6c0 2.8-2.4 4.2-3.6 6.1-.2.3-.6.5-1.4.5s-1.2-.2-1.4-.5C9.4 10.5 7 9.1 7 6.3V4.7Z\"/><path d=\"M12 11.6c.8 0 1.2.2 1.4.5 1.2 1.9 3.6 3.3 3.6 6.1v1.6H7v-1.6c0-2.8 2.4-4.2 3.6-6.1.2-.3.6-.5 1.4-.5Z\"/>"},"Anon":{"cls":"a-mask","anim":"mask float","outline":"<g class=\"mface\"><path d=\"M3.5 7.8c2.3-1.7 4.9-1.8 6.7-.6l1.8.9 1.8-.9c1.8-1.2 4.4-1.1 6.7.6 0 4.8-2.7 8.2-8.5 8.2S3.5 12.6 3.5 7.8Z\"/></g><path class=\"meye\" d=\"M7 10.8c.9-1.1 2.1-1.1 3 0\"/><path class=\"meye\" d=\"M14 10.8c.9-1.1 2.1-1.1 3 0\"/>","filled":"<path fill-rule=\"evenodd\" d=\"M3.5 7.8c2.3-1.7 4.9-1.8 6.7-.6l1.8.9 1.8-.9c1.8-1.2 4.4-1.1 6.7.6 0 4.8-2.7 8.2-8.5 8.2S3.5 12.6 3.5 7.8Zm3.3 3.1c.9-1.2 2.2-1.2 3.1 0-.9 1.2-2.2 1.2-3.1 0Zm7.3 0c.9-1.2 2.2-1.2 3.1 0-.9 1.2-2.2 1.2-3.1 0Z\"/>"},"Key":{"cls":"a-key","anim":"key turn","outline":"<g class=\"kall\"><circle cx=\"7.8\" cy=\"7.8\" r=\"4.5\"/><path d=\"M11 11l9.5 9.5M15.6 15.4l2.6-2.6M18.7 18.5l2.3-2.3\"/></g>","filled":"<path fill-rule=\"evenodd\" d=\"M7.8 3.3a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9Zm0 6.4a1.9 1.9 0 1 1 0-3.8 1.9 1.9 0 1 1 0 3.8Z\"/><path d=\"M12.4 9.6l9.4 9.4-2.8 2.8-9.4-9.4Z\"/><path d=\"M15.8 13.9l1.9 1.9-1.9 1.9-1.9-1.9Z\"/><path d=\"M18.6 17.1l1.5 1.5-1.5 1.5-1.5-1.5Z\"/>"},"Back":{"cls":"a-back","anim":"slide back","outline":"<path d=\"M20 12H4.5\"/><path d=\"M10.5 5.5L4 12l6.5 6.5\"/>","filled":"<path class=\"st\" d=\"M20 12H5M10.8 5.8L4.6 12l6.2 6.2\" stroke-width=\"3.2\"/>"},"Close":{"cls":"a-close","anim":"draw & fade","outline":"<path class=\"xl1\" d=\"M6.2 6.2l11.6 11.6\"/><path class=\"xl2\" d=\"M17.8 6.2L6.2 17.8\"/>","filled":"<path class=\"st\" d=\"M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8\" stroke-width=\"3.4\"/>"},"Sliders":{"cls":"a-slider","anim":"knob slide","outline":"<path d=\"M4 6.5h16M4 12h16M4 17.5h16\" stroke-opacity=\".4\"/><circle class=\"s1\" cx=\"15\" cy=\"6.5\" r=\"2.2\" fill=\"var(--ink)\"/><circle class=\"s2\" cx=\"8.5\" cy=\"12\" r=\"2.2\" fill=\"var(--ink)\"/><circle class=\"s3\" cx=\"13\" cy=\"17.5\" r=\"2.2\" fill=\"var(--ink)\"/>","filled":"<rect x=\"4\" y=\"5.6\" width=\"16\" height=\"1.8\" rx=\".9\"/><rect x=\"4\" y=\"11.1\" width=\"16\" height=\"1.8\" rx=\".9\"/><rect x=\"4\" y=\"16.6\" width=\"16\" height=\"1.8\" rx=\".9\"/><circle cx=\"15\" cy=\"6.5\" r=\"2.9\"/><circle cx=\"8.5\" cy=\"12\" r=\"2.9\"/><circle cx=\"13\" cy=\"17.5\" r=\"2.9\"/>"},"Verified":{"cls":"a-verified","anim":"seal pulse","outline":"<path class=\"vstar\" d=\"M12 2.9l2.7 5.6 6.2.9-4.5 4.4 1.1 6.2-5.5-2.9-5.5 2.9 1.1-6.2L3.1 9.4l6.2-.9L12 2.9Z\"/><path class=\"vchk\" d=\"M8.9 12.9l2 2 4.2-4.7\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"2\"/>","filled":"<path fill-rule=\"evenodd\" d=\"M12 2.9l2.7 5.6 6.2.9-4.5 4.4 1.1 6.2-5.5-2.9-5.5 2.9 1.1-6.2L3.1 9.4l6.2-.9L12 2.9Zm-3.2 10 2.1 2.1 4.3-4.8-1.4-1.3-3 3.4-.7-.7Z\"/>"},"Follow":{"cls":"a-follow","anim":"plus pop","outline":"<circle cx=\"9.5\" cy=\"7.8\" r=\"3.9\"/><path d=\"M3.2 19.9c.8-3.5 3.4-5.5 6.3-5.5 1.5 0 2.9.5 4 1.3\"/><path class=\"fplus\" d=\"M18.5 13.5v6M15.5 16.5h6\"/>","filled":"<circle cx=\"9.5\" cy=\"7.3\" r=\"4.1\"/><path d=\"M9.5 12.5c-3.3 0-6 2-6.8 5.3-.2.6.3 1.2 1 1.2h11.6c.7 0 1.2-.6 1-1.2-.8-3.3-3.5-5.3-6.8-5.3Z\"/><rect x=\"15.3\" y=\"15.6\" width=\"6.4\" height=\"1.9\" rx=\".95\"/><rect x=\"17.55\" y=\"13.35\" width=\"1.9\" height=\"6.4\" rx=\".95\"/>"},"More":{"cls":"a-more","anim":"wave dots","outline":"<circle class=\"md\" cx=\"5.2\" cy=\"12\" r=\"1.7\"/><circle class=\"md m2\" cx=\"12\" cy=\"12\" r=\"1.7\"/><circle class=\"md m3\" cx=\"18.8\" cy=\"12\" r=\"1.7\"/>","filled":"<circle cx=\"5.2\" cy=\"12\" r=\"2.3\"/><circle cx=\"12\" cy=\"12\" r=\"2.3\"/><circle cx=\"18.8\" cy=\"12\" r=\"2.3\"/>"},"Story":{"cls":"a-story","anim":"ring spin","outline":"<circle class=\"ringc\" cx=\"12\" cy=\"12\" r=\"8.6\" stroke-dasharray=\"3.4 2.7\"/><path d=\"M12 9.6v4.8M9.6 12h4.8\"/>","filled":"<circle class=\"st\" cx=\"12\" cy=\"12\" r=\"8.6\" stroke-width=\"3\"/><path class=\"st\" d=\"M12 9.2v5.6M9.2 12h5.6\" stroke-width=\"3\"/>"},"DM":{"cls":"a-dm","anim":"flap open","outline":"<g class=\"dbody\"><rect x=\"3.5\" y=\"5.5\" width=\"17\" height=\"13\" rx=\"2.5\"/></g><path class=\"flap\" d=\"M4.5 7.5l7.5 5.5 7.5-5.5\"/>","filled":"<path fill-rule=\"evenodd\" d=\"M6 5.5h12a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 16V8A2.5 2.5 0 0 1 6 5.5ZM5.2 8.8 12 13.2l6.8-4.4-.9-1.5L12 11.5 6.1 7.3Z\"/>"},"Pin":{"cls":"a-pin","anim":"pin drop","outline":"<path d=\"M12 21.4c4.3-4.2 6.8-7.7 6.8-10.9a6.8 6.8 0 0 0-13.6 0c0 3.2 2.5 6.7 6.8 10.9Z\"/><circle class=\"pindot\" cx=\"12\" cy=\"10.4\" r=\"2.5\"/>","filled":"<path fill-rule=\"evenodd\" d=\"M12 21.4c4.3-4.2 6.8-7.7 6.8-10.9a6.8 6.8 0 0 0-13.6 0c0 3.2 2.5 6.7 6.8 10.9Zm0-11a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5Z\"/>"},"Mic":{"cls":"a-mic","anim":"talk pulse","outline":"<rect class=\"micc\" x=\"9\" y=\"3.5\" width=\"6\" height=\"10.5\" rx=\"3\"/><path d=\"M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.8M9.2 20.8h5.6\"/>","filled":"<rect x=\"9\" y=\"3.5\" width=\"6\" height=\"10.5\" rx=\"3\"/><path class=\"st\" d=\"M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.8M9.2 20.8h5.6\" stroke-width=\"2.2\"/>"},"Edit":{"cls":"a-edit","anim":"writing jiggle","outline":"<g class=\"pencil\"><path d=\"M14.5 5.5l4 4L8.5 19.5H4.5v-4L14.5 5.5Z\"/><path d=\"M12.6 7.4l4 4\"/></g>","filled":"<path d=\"M14.5 5.5l4 4L8.5 19.5H4.5v-4L14.5 5.5Z\"/>"},"Delete":{"cls":"a-trash","anim":"bin shake","outline":"<g class=\"binb\"><path d=\"M4.5 6.5h15M9.5 6.5V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.3 6.5l.9 12.6a1.5 1.5 0 0 0 1.5 1.4h6.6a1.5 1.5 0 0 0 1.5-1.4l.9-12.6\"/><path d=\"M10 10.5v6M14 10.5v6\"/></g>","filled":"<path class=\"st\" d=\"M4.5 6.5h15M9.5 6.5V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2\" stroke-width=\"2.2\"/><path d=\"M6.3 6.5l.9 12.6a1.5 1.5 0 0 0 1.5 1.4h6.6a1.5 1.5 0 0 0 1.5-1.4l.9-12.5Z\"/>"}};
var MAP={"home":"Home","search":"Search","search-x":"Search","bell":"Bell","heart":"Like","bookmark":"Save","camera":"Camera","lock":"Lock","shield-check":"Shield","badge-check":"Verified","arrow-left":"Back","x":"Close","trash-2":"Delete","mic":"Mic","mic-2":"Mic","message-circle":"Comment","send":"Share","play":"Reels","plus":"Create","plus-square":"Create","user-plus":"Follow","user":"Profile","users":"Profile","contact":"Profile","more-horizontal":"More","more-vertical":"More","settings":"Sliders","key-round":"Key","timer":"Burns","film":"Story"};
var KF=["tdot","cellwave","comet","sway","pluspop","playpulse","msgbounce","ring","clapper","beat","hspark","cbub","trailflow","fly","dropin","lensp","flashb","bob","lockdrop","khglow","schk","eblink","slashin","flip","grain","maskfloat","squint","turn","backslide","xdraw","kn1","kn2","kn3","vstar","vchk","fplus","spin360","flapdraw","nudgex","pindrop","dotpulse","talk","write","binshake","mup"];

/* ---------- scoped style ---------- */
var css="/* PRIV SPACA — Icon Set v2 override layer (auto-generated) */\n.psv2{fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;width:24px;height:24px}\n.psv2 *{transform-box:fill-box}\n.psv2-fill{fill:currentColor;stroke:none}\n.psv2-fill .st{stroke:currentColor;fill:none;stroke-linecap:round;stroke-linejoin:round}\n@keyframes ps2tap{0%{transform:scale(1) rotate(0)28%{transform:scale(1.3) rotate(-5deg)55%{transform:scale(.92) rotate(3deg)80%{transform:scale(1.06) rotate(0)100%{transform:scale(1)}}\n.psv2-tap{animation:ps2tap .55s cubic-bezier(.36,1.6,.5,1)}\n.psv2 *{transform-box:fill-box}\n.psv2-fill{fill:currentColor;stroke:none}\n.psv2-fill .st{stroke:currentColor;fill:none;stroke-linecap:round;stroke-linejoin:round}\n@keyframes ps2tdot{0%,60%,100%{opacity:.3;transform:translateY(0) scale(1)}30%{opacity:1;transform:translateY(-1.2px) scale(1.18)}}\n@keyframes ps2cellwave{0%,30%,100%{opacity:.45;transform:scale(1)}12%{opacity:1;transform:scale(1.1)}}\n.psv2.a-home .hc{transform-origin:center;animation:ps2cellwave 2.8s ease-in-out infinite;animation-delay:calc(var(--td,0s) + var(--o,0s))}\n.psv2.a-home .c2{--o:.2s}\n.psv2.a-home .c3{--o:.4s}\n.psv2.a-home .c4{--o:.6s}\n@keyframes ps2comet{to{stroke-dashoffset:-42.73}}\n@keyframes ps2sway{0%,100%{transform:rotate(0)}30%{transform:rotate(-7deg)}55%{transform:rotate(5deg)}75%{transform:rotate(-2deg)}}\n.psv2.a-search{animation:ps2sway 2.8s ease-in-out infinite;animation-delay:var(--td,0s)}\n.psv2.a-search .lens{stroke-dasharray:13 29.73;animation:ps2comet 2.8s linear infinite;animation-delay:var(--td,0s)}\n@keyframes ps2pluspop{0%,55%,100%{transform:rotate(0deg) scale(1)}70%{transform:rotate(300deg) scale(.85)}85%{transform:rotate(360deg) scale(1.12)}}\n.psv2.a-create .plus{transform-origin:center;animation:ps2pluspop 3.4s cubic-bezier(.5,0,.3,1.4) infinite;animation-delay:var(--td,0s)}\n@keyframes ps2playpulse{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(1.24);opacity:1}}\n.psv2.a-reels .tri{transform-origin:center;animation:ps2playpulse 2.1s ease-in-out infinite;animation-delay:var(--td,0s)}\n@keyframes ps2msgbounce{0%,100%{transform:translateY(0) rotate(0)}25%{transform:translateY(-1.9px) rotate(-1.6deg)}45%{transform:translateY(0) rotate(1deg)}60%{transform:translateY(-.8px) rotate(0)}75%{transform:translateY(0)}}\n.psv2.a-inbox .bub{transform-origin:20% 100%;animation:ps2msgbounce 2.9s cubic-bezier(.36,1.6,.5,1) infinite;animation-delay:var(--td,0s)}\n.psv2.a-inbox .id{fill:currentColor;stroke:none;transform-origin:center;animation:ps2tdot 1.8s ease-in-out infinite;animation-delay:calc(var(--td,0s) + var(--o,0s))}\n.psv2.a-inbox .d2{--o:.22s}\n.psv2.a-inbox .d3{--o:.44s}\n@keyframes ps2ring{0%,55%,100%{transform:rotate(0)}8%{transform:rotate(14deg)}16%{transform:rotate(-12deg)}24%{transform:rotate(8deg)}32%{transform:rotate(-5deg)}42%{transform:rotate(2deg)}}\n@keyframes ps2clapper{0%,55%,100%{transform:rotate(0)}10%{transform:rotate(-20deg)}20%{transform:rotate(16deg)}30%{transform:rotate(-9deg)}40%{transform:rotate(0)}}\n.psv2.a-bell .bbody{transform-origin:50% 4%;animation:ps2ring 3.2s ease-in-out infinite;animation-delay:var(--td,0s)}\n.psv2.a-bell .bclap{transform-origin:50% 0%;animation:ps2clapper 3.2s ease-in-out infinite;animation-delay:var(--td,0s)}\n@keyframes ps2beat{0%,100%{transform:scale(1)}12%{transform:scale(1.12)}24%{transform:scale(1)}38%{transform:scale(1.22)}54%{transform:scale(1)}}\n@keyframes ps2hspark{0%,36%,100%{opacity:0;transform:scale(.3) rotate(0)}48%{opacity:1;transform:scale(1.15) rotate(40deg)}64%{opacity:0;transform:scale(.5) rotate(80deg)}}\n.psv2.a-heart .hb{transform-origin:center;animation:ps2beat 1.9s ease-in-out infinite;animation-delay:var(--td,0s)}\n.psv2.a-heart .hsp{transform-origin:center;animation:ps2hspark 1.9s ease-in-out infinite;animation-delay:calc(var(--td,0s) + .5s)}\n@keyframes ps2cbub{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}\n.psv2.a-comment .cbub{transform-origin:center;animation:ps2cbub 1.8s ease-in-out infinite;animation-delay:var(--td,0s)}\n.psv2.a-comment .id{fill:currentColor;stroke:none;transform-origin:center;animation:ps2tdot 1.8s ease-in-out infinite;animation-delay:calc(var(--td,0s) + var(--o,0s))}\n.psv2.a-comment .d2{--o:.22s}\n.psv2.a-comment .d3{--o:.44s}\n@keyframes ps2trailflow{to{stroke-dashoffset:-10.8}}\n@keyframes ps2fly{0%{transform:translate(-2.8px,2.8px);opacity:0}18%{opacity:1}62%{transform:translate(1.6px,-1.6px);opacity:1}82%,100%{transform:translate(3.6px,-3.6px);opacity:0}}\n.psv2.a-share .trail{animation:ps2trailflow 1.2s linear infinite}\n.psv2.a-share .plane{animation:ps2fly 3s cubic-bezier(.5,0,.4,1) infinite;animation-delay:var(--td,0s)}\n@keyframes ps2dropin{0%,100%{transform:translateY(0)}42%{transform:translateY(-2.6px)}56%{transform:translateY(.6px)}68%{transform:translateY(-1.2px)}80%{transform:translateY(0)}}\n.psv2.a-bookmark .bm{transform-origin:center;animation:ps2dropin 3.2s cubic-bezier(.36,1.6,.5,1) infinite;animation-delay:var(--td,0s)}\n@keyframes ps2lensp{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}\n@keyframes ps2flashb{0%,86%,100%{opacity:0;transform:scale(.4)}91%{opacity:1;transform:scale(1.3)}96%{opacity:0;transform:scale(.5)}}\n.psv2.a-cam .clens{transform-origin:center;animation:ps2lensp 2.6s ease-in-out infinite;animation-delay:var(--td,0s)}\n.psv2.a-cam .cfl{transform-origin:center;animation:ps2flashb 2.6s linear infinite;animation-delay:var(--td,0s)}\n@keyframes ps2bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.5px)}}\n.psv2.a-profile .phead{animation:ps2bob 2.4s ease-in-out infinite;animation-delay:var(--td,0s)}\n@keyframes ps2lockdrop{0%,100%{transform:translateY(0)}45%{transform:translateY(-2.4px)}62%{transform:translateY(.5px)}76%{transform:translateY(0)}}\n@keyframes ps2khglow{0%,40%,100%{opacity:.4;transform:scale(1)}60%{opacity:1;transform:scale(1.3)}}\n.psv2.a-lock .lshk{animation:ps2lockdrop 3.4s cubic-bezier(.36,1.6,.5,1) infinite;animation-delay:var(--td,0s)}\n.psv2.a-lock .lkho{transform-origin:center;animation:ps2khglow 3.4s ease-in-out infinite;animation-delay:var(--td,0s)}\n@keyframes ps2schk{0%,48%{stroke-dashoffset:10.3;opacity:0}56%{opacity:1}70%,94%{stroke-dashoffset:0;opacity:1}100%{stroke-dashoffset:0;opacity:0}}\n.psv2.a-shield .schk{stroke-dasharray:10.3;stroke-dashoffset:10.3;animation:ps2schk 3.2s ease-in-out infinite;animation-delay:var(--td,0s)}\n@keyframes ps2eblink{0%,10%,26%,100%{transform:scaleY(1)}16%,20%{transform:scaleY(.07)}}\n@keyframes ps2slashin{0%,34%{stroke-dashoffset:23;opacity:0}40%{opacity:1}56%,90%{stroke-dashoffset:0;opacity:1}98%,100%{stroke-dashoffset:0;opacity:0}}\n.psv2.a-eye .eyeg{transform-origin:center;animation:ps2eblink 3.6s ease-in-out infinite;animation-delay:var(--td,0s)}\n.psv2.a-eye .eslash{stroke-dasharray:23;stroke-dashoffset:23;animation:ps2slashin 3.6s ease-in-out infinite;animation-delay:var(--td,0s)}\n@keyframes ps2flip{0%,38%{transform:rotate(0)}50%{transform:rotate(-205deg)}57%{transform:rotate(-178deg)}63%{transform:rotate(-186deg)}70%,76%{transform:rotate(-180deg)}88%{transform:rotate(-366deg)}94%{transform:rotate(-354deg)}100%{transform:rotate(-360deg)}}\n@keyframes ps2grain{0%,48%{opacity:0;transform:translateY(0)}54%{opacity:1}70%{opacity:1;transform:translateY(5.5px)}78%,100%{opacity:0;transform:translateY(5.5px)}}\n.psv2.a-hour .hg{transform-origin:center;animation:ps2flip 4.4s cubic-bezier(.55,0,.3,1.2) infinite;animation-delay:var(--td,0s)}\n.psv2.a-hour .grain{animation:ps2grain 4.4s ease-in infinite;animation-delay:var(--td,0s)}\n@keyframes ps2maskfloat{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-1.6px) rotate(-2deg)}}\n@keyframes ps2squint{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.3)}}\n.psv2.a-mask .mface{transform-origin:center;animation:ps2maskfloat 3.2s ease-in-out infinite;animation-delay:var(--td,0s)}\n.psv2.a-mask .meye{transform-origin:center;animation:ps2squint 3.2s ease-in-out infinite;animation-delay:calc(var(--td,0s) + .2s)}\n@keyframes ps2turn{0%,52%,100%{transform:rotate(0)}64%{transform:rotate(-26deg)}78%{transform:rotate(9deg)}90%{transform:rotate(0)}}\n.psv2.a-key .kall{transform-origin:26% 26%;animation:ps2turn 3.4s cubic-bezier(.55,0,.3,1.5) infinite;animation-delay:var(--td,0s)}\n@keyframes ps2backslide{0%,100%{transform:translateX(0)}35%{transform:translateX(-2.8px)}55%{transform:translateX(.9px)}70%{transform:translateX(0)}}\n.psv2.a-back{animation:ps2backslide 2.8s ease-in-out infinite;animation-delay:var(--td,0s)}\n@keyframes ps2xdraw{0%{stroke-dashoffset:17;opacity:1}26%{stroke-dashoffset:0}68%{stroke-dashoffset:0;opacity:1}86%,100%{stroke-dashoffset:0;opacity:0}}\n.psv2.a-close .xl1{stroke-dasharray:17;stroke-dashoffset:17;animation:ps2xdraw 3.2s ease-in-out infinite;animation-delay:var(--td,0s)}\n.psv2.a-close .xl2{stroke-dasharray:17;stroke-dashoffset:17;animation:ps2xdraw 3.2s ease-in-out infinite;animation-delay:calc(var(--td,0s) + .35s)}\n@keyframes ps2kn1{0%,100%{transform:translateX(0)}50%{transform:translateX(-4.6px)}}\n@keyframes ps2kn2{0%,100%{transform:translateX(0)}50%{transform:translateX(3.4px)}}\n@keyframes ps2kn3{0%,100%{transform:translateX(0)}50%{transform:translateX(-2.8px)}}\n.psv2.a-slider .s1{animation:ps2kn1 3s ease-in-out infinite;animation-delay:var(--td,0s)}\n.psv2.a-slider .s2{animation:ps2kn2 3.4s ease-in-out infinite;animation-delay:calc(var(--td,0s) + .2s)}\n.psv2.a-slider .s3{animation:ps2kn3 2.7s ease-in-out infinite;animation-delay:calc(var(--td,0s) + .4s)}\n@keyframes ps2vstar{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}\n@keyframes ps2vchk{0%,38%{stroke-dashoffset:9.2;opacity:0}48%{opacity:1}62%,100%{stroke-dashoffset:0;opacity:1}}\n.psv2.a-verified .vstar{transform-origin:center;animation:ps2vstar 2.8s ease-in-out infinite;animation-delay:var(--td,0s)}\n.psv2.a-verified .vchk{stroke-dasharray:9.2;stroke-dashoffset:9.2;animation:ps2vchk 2.8s ease-in-out infinite;animation-delay:var(--td,0s)}\n@keyframes ps2fplus{0%,42%,100%{transform:scale(1);opacity:1}54%{transform:scale(0);opacity:0}70%{transform:scale(1.18);opacity:1}84%{transform:scale(1)}}\n.psv2.a-follow .fplus{transform-origin:center;animation:ps2fplus 2.8s cubic-bezier(.36,1.6,.5,1) infinite;animation-delay:var(--td,0s)}\n.psv2.a-more .md{transform-origin:center;animation:ps2tdot 1.5s ease-in-out infinite;animation-delay:calc(var(--td,0s) + var(--o,0s))}\n.psv2.a-more .m2{--o:.2s}\n.psv2.a-more .m3{--o:.4s}\n@keyframes ps2spin360{to{transform:rotate(360deg)}}\n.psv2.a-story .ringc{transform-origin:center;animation:ps2spin360 7s linear infinite;animation-delay:var(--td,0s)}\n@keyframes ps2flapdraw{0%{stroke-dashoffset:19}30%{stroke-dashoffset:0}100%{stroke-dashoffset:0}}\n@keyframes ps2nudgex{0%,22%,100%{transform:translateX(0)}32%{transform:translateX(-1.4px)}44%{transform:translateX(.8px)}56%{transform:translateX(0)}}\n.psv2.a-dm .flap{stroke-dasharray:19;stroke-dashoffset:19;animation:ps2flapdraw 3.2s ease-in-out infinite;animation-delay:var(--td,0s)}\n.psv2.a-dm .dbody{animation:ps2nudgex 3.2s ease-in-out infinite;animation-delay:var(--td,0s)}\n@keyframes ps2pindrop{0%,100%{transform:translateY(0)}38%{transform:translateY(-3px)}52%{transform:translateY(.6px)}64%{transform:translateY(-1px)}76%{transform:translateY(0)}}\n@keyframes ps2dotpulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.3);opacity:.65}}\n.psv2.a-pin{animation:ps2pindrop 3s cubic-bezier(.36,1.6,.5,1) infinite;animation-delay:var(--td,0s)}\n.psv2.a-pin .pindot{transform-origin:center;animation:ps2dotpulse 3s ease-in-out infinite;animation-delay:var(--td,0s)}\n@keyframes ps2talk{0%,100%{transform:scale(1)}30%{transform:scale(1.08,1.14)}55%{transform:scale(.96,.94)}}\n.psv2.a-mic .micc{transform-origin:center;animation:ps2talk 2.4s ease-in-out infinite;animation-delay:var(--td,0s)}\n@keyframes ps2write{0%,100%{transform:translate(0,0)}25%{transform:translate(-.9px,.9px)}50%{transform:translate(-1.7px,1.7px)}75%{transform:translate(-.9px,.9px)}}\n.psv2.a-edit .pencil{animation:ps2write 1.6s ease-in-out infinite;animation-delay:var(--td,0s)}\n@keyframes ps2binshake{0%,100%{transform:rotate(0)}20%{transform:rotate(5deg)}40%{transform:rotate(-5deg)}60%{transform:rotate(3deg)}80%{transform:rotate(-2deg)}}\n.psv2.a-trash .binb{transform-origin:50% 20%;animation:ps2binshake 2.6s ease-in-out infinite;animation-delay:var(--td,0s)}\n@keyframes ps2mup{from{opacity:0;transform:translateY(24px) scale(.96)}to{opacity:1;transform:none}}\n@media (prefers-reduced-motion: reduce){.psv2,.psv2 *,.psv2-fill *{animation:none!important}}";
var st=document.createElement('style');st.id='psv2-style';st.textContent=css;
(document.head||document.documentElement).appendChild(st);

/* ---------- helpers ---------- */
function esc(n){return 'psv2-'+n.toLowerCase();}

function buildIcon(v2name){
  var c=ICONS[v2name];
  var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');
  svg.setAttribute('aria-hidden','true');
  svg.setAttribute('class','psv2 '+c.cls);
  svg.dataset.psv2=v2name;
  svg.dataset.psfill='out';
  svg.innerHTML=c.outline;
  return svg;
}

var CONTROL_TAG=/^(BUTTON|A|SUMMARY|LABEL)$/;
function isControl(el){
  if(!el||!el.classList)return false;
  if(CONTROL_TAG.test(el.tagName))return true;
  if(el.getAttribute&&el.getAttribute('role')==='button')return true;
  var c=el.classList;
  return c.contains('ig-tab')||c.contains('stat-btn')||c.contains('bn-btn')||c.contains('inbox-seg-btn')||c.contains('post-action')||c.contains('ig-action-btn')||c.contains('music-layout-btn')||c.contains('story-pill');
}
function isFilledState(icon){
  /* nearest control within 3 levels decides; container-level 'active' (views/panes) never fills */
  var el=icon.parentElement,d=0;
  while(el&&d<3){
    if(isControl(el)){
      var c=el.classList;
      if(c.contains('active')||c.contains('is-active')||c.contains('liked'))return true;
      if(el.getAttribute&&el.getAttribute('aria-pressed')==='true')return true;
      return false;
    }
    el=el.parentElement;d++;
  }
  return false;
}

function syncFill(icon){
  var want=isFilledState(icon)?'fill':'out';
  if(icon.dataset.psfill===want)return;
  var c=ICONS[icon.dataset.psv2];if(!c)return;
  icon.dataset.psfill=want;
  icon.classList.toggle('psv2-fill',want==='fill');
  icon.classList.toggle('psv2-out',want==='out');
  icon.innerHTML=want==='fill'?c.filled:c.outline;
}

function syncAll(){
  var all=document.querySelectorAll('svg.psv2');
  for(var i=0;i<all.length;i++)syncFill(all[i]);
}

function swapOne(old){
  var cls=old.className&&old.className.baseVal!==undefined?String(old.className.baseVal):String(old.className||'');
  var mm=cls.match(/lucide-([a-z0-9-]+)/)||({});
  var name=mm[1]||(old.getAttribute?old.getAttribute('data-lucide'):null);
  if(!name)return;
  var v2=MAP[name];if(!v2)return;
  var fresh=buildIcon(v2);
  /* keep sizing + a11y attrs from the lucide svg */
  ['width','height','style','aria-label','title'].forEach(function(a){
    var v=old.getAttribute&&old.getAttribute(a);
    if(v!=null)fresh.setAttribute(a,v);
  });
  /* keep original lucide classes so app CSS targeting .lucide still applies */
  var keep=cls.split(/\s+/).filter(function(c){return c&&c!=='lucide'&&c.indexOf('lucide-')!==0;});
  fresh.setAttribute('class',(keep.join(' ')+' lucide psv2 '+ICONS[v2].cls).trim());
  fresh.dataset.psv2=v2;
  fresh.dataset.psfill=isFilledState(old)?'fill':'out';
  if(fresh.dataset.psfill==='fill'){
    fresh.classList.add('psv2-fill');fresh.innerHTML=ICONS[v2].filled;
  }else{
    fresh.classList.add('psv2-out');
  }
  old.parentNode.replaceChild(fresh,old);
}

function sweep(root){
  root=root||document;
  if(root.querySelectorAll){
    var list=root.querySelectorAll('svg.lucide');
    for(var i=0;i<list.length;i++){
      if(list[i].classList&&list[i].classList.contains('psv2'))continue;
      var m=String(list[i].getAttribute('class')||'').match(/lucide-([a-z0-9-]+)/);
      if(m&&MAP[m[1]])swapOne(list[i]);
    }
    /* <i data-lucide> that lucide never processed (e.g. lucide still loading) */
    var is=root.querySelectorAll('i[data-lucide]');
    for(var j=0;j<is.length;j++){
      var nm=is[j].getAttribute('data-lucide');
      if(nm&&MAP[nm])swapOne(is[j]);
    }
  }
  syncAll();
}

/* ---------- hook lucide.createIcons (covers every app render path) ---------- */
function wrapLucide(){
  var L=window.lucide;
  if(L&&typeof L.createIcons==='function'&&!L.__psv2Wrapped){
    var orig=L.createIcons;
    L.createIcons=function(){
      var r;
      try{r=orig.apply(this,arguments);}catch(e){r=undefined;}
      try{sweep(document);}catch(e){}
      return r;
    };
    L.__psv2Wrapped=true;
  }
}

/* ---------- observer: catch icons + class toggles ---------- */
var mo=null,queued=false;
function observe(){
  if(mo||!window.MutationObserver||!document.body)return;
  mo=new MutationObserver(function(){
    if(queued)return;queued=true;
    setTimeout(function(){queued=false;try{sweep(document);}catch(e){}},0);
  });
  mo.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','aria-pressed']});
}

/* ---------- tap reaction: spring pop + replay the icon's signature anim ---------- */
function tapFx(s){
  if(!s||!s.classList||s.classList.contains('psv2-tap'))return;
  s.classList.add('psv2-tap');
  var acls=null;
  for(var i=0;i<s.classList.length;i++)if(s.classList[i].indexOf('a-')===0){acls=s.classList[i];break;}
  if(acls){
    s.classList.remove(acls);
    void s.getBoundingClientRect(); /* reflow -> sub-element keyframes restart from 0 */
    s.classList.add(acls);
  }
  setTimeout(function(){try{s.classList.remove('psv2-tap');}catch(e){}},620);
}
function onTap(e){
  var t=e.target;
  if(!t||!t.closest)return;
  var s=t.closest('svg.psv2');
  if(s)tapFx(s);
}

/* ---------- init ---------- */
function init(){
  wrapLucide();
  try{sweep(document);}catch(e){}
  observe();
  if(!window.__PSV2_TAPBOUND__){
    window.__PSV2_TAPBOUND__=true;
    try{
      document.addEventListener('pointerdown',onTap,{passive:true});
      document.addEventListener('click',onTap,{passive:true});
    }catch(e){}
  }
}
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',function(){init();wrapLucide();});
}else{init();}
/* lucide may load lazily — keep trying a few ticks */
var ticks=0;
var t=setInterval(function(){ticks++;wrapLucide();if(window.lucide&&window.lucide.__psv2Wrapped&&ticks>2)clearInterval(t);if(ticks>20)clearInterval(t);},500);
})();
