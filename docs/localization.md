# Translating Waveform

Firefox selects the extension language from its display language. Waveform ships
English and Spanish and falls back to English for missing messages.

To contribute a language, copy [`_locales/en/messages.json`](../_locales/en/messages.json)
into a new `_locales/<locale>/messages.json` and translate its `message` values.
Set `locale` to the language tag used by screen readers, such as `es` or `pt-BR`.
For a regional catalog, use underscores in the directory name, such as `pt_BR`.
Keep the message keys, `$placeholder$` names, and `placeholders` definitions.
Keep the product name **Waveform**. Open a pull request with the translated catalog.

## Firefox Add-ons listing

Contributors can submit translations of the name, summary, and description below
in the same pull request. A maintainer can select the matching language under
**Edit Listing** in the [Add-ons Developer Hub](https://addons.mozilla.org/developers/)
and save the translated fields. Existing listings are managed separately from the
extension’s packaged catalogs.

### English (`en-US`)

**Name**

Waveform

**Summary**

Adjust volume per tab, boost compatible players, and inspect audio and video sources. Open source with no data collection.

**Description**

Set an independent volume for each Firefox tab. Use the tab mixer to find playing
tabs, adjust their volume, or mute them. Waveform can remember your volume and
control method for each website.

Auto adjusts volume normally and boosts compatible sources above 100%. Standard
uses the player’s ordinary volume control, and Boost uses Web Audio where
supported. Media details shows detected sources, stream formats, and codecs.

Waveform follows Firefox’s appearance or lets you choose Light or Dark. Larger
text is available in Settings. Waveform is open source and collects no data.

### Español (`es`)

**Nombre**

Waveform

**Resumen**

Ajusta el volumen por pestaña, amplifica los reproductores compatibles y consulta las fuentes de audio y vídeo. Código abierto y sin recopilación de datos.

**Descripción**

Ajusta el volumen de cada pestaña de Firefox de forma independiente. Usa el
mezclador para encontrar pestañas que estén reproduciendo audio, ajustar su
volumen o silenciarlas. Waveform puede recordar el volumen y el método de control
de cada sitio web.

El modo Auto ajusta el volumen y amplifica las fuentes compatibles por encima del
100 %. El modo Estándar usa el control de volumen del reproductor y Amplificar usa
Web Audio cuando es compatible. Los detalles multimedia muestran las fuentes,
los formatos de transmisión y los códecs detectados.

Waveform sigue la apariencia de Firefox o te permite elegir el tema claro u
oscuro. Puedes activar el texto más grande en los ajustes. Waveform es de código
abierto y no recopila datos.
