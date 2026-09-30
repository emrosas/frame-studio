// The built-in typefaces (ADR 0010): where each font comes from, the
// instance a variable font is fixed at, and its license. `npm run typeface --
// --builtins` downloads them into build/type-cache/ and writes
// src/rigs/type/faces/. Every one is under the SIL Open Font License 1.1
// with no Reserved Font Name, so converting and subsetting are allowed. Node only.

const GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl';
const OFL = 'SIL Open Font License 1.1, https://openfontlicense.org';

export interface BuiltinTypeface {
  id: string;
  name: string;
  /** The font file, or a zip that holds it. */
  url: string;
  /** The font's path inside the zip at url. */
  member?: string;
  /** A variable font's instance. The built-ins use static builds, whose overlapping contours are merged, so an outline stroke shows no seams. */
  axes?: Record<string, number>;
  license: string;
}

// Static builds from each project's own releases: a variable font keeps overlapping contours, which show when text is outlined.
const interZip = 'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip';
const inter = `Inter: Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter). ${OFL}`;
const instrument = `Instrument Serif: Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif). ${OFL}`;

export const BUILTINS: readonly BuiltinTypeface[] = [
  { id: 'inter', name: 'Inter', url: interZip, member: 'extras/ttf/Inter-Regular.ttf', license: inter },
  { id: 'inter-bold', name: 'Inter Bold', url: interZip, member: 'extras/ttf/Inter-Bold.ttf', license: inter },
  { id: 'inter-display', name: 'Inter Display Black', url: interZip, member: 'extras/ttf/InterDisplay-Black.ttf', license: inter },
  { id: 'instrument-serif', name: 'Instrument Serif', url: `${GF}/instrumentserif/InstrumentSerif-Regular.ttf`, license: instrument },
  { id: 'instrument-serif-italic', name: 'Instrument Serif Italic', url: `${GF}/instrumentserif/InstrumentSerif-Italic.ttf`, license: instrument },
  {
    id: 'fraunces',
    name: 'Fraunces Semibold',
    url: 'https://raw.githubusercontent.com/undercasetype/Fraunces/master/fonts/ttf/Fraunces72pt-SemiBold.ttf',
    license: `Fraunces: Copyright 2018 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces). ${OFL}`,
  },
  {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    url: 'https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/fonts/ttf/JetBrainsMono-Regular.ttf',
    license: `JetBrains Mono: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono). ${OFL}`,
  },
];

/** The license text shipped beside the modules. Every built-in shares it. */
export const OFL_URL = `${GF}/inter/OFL.txt`;
