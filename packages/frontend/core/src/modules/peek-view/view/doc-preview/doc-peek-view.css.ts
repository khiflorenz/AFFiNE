import { cssVar } from '@toeverything/theme';
import { globalStyle, style } from '@vanilla-extract/css';

export const root = style({
  containerType: 'inline-size',
});

export const editor = style({
  vars: {
    '--affine-editor-side-padding': '160px',
  },
  minHeight: '100%',
});

globalStyle(`[data-full-width-layout="true"] ${editor}`, {
  vars: {
    '--affine-editor-width': '100%',
    '--affine-editor-side-padding': '24px',
  },
});

export const affineDocViewport = style({
  display: 'flex',
  flexDirection: 'column',
  userSelect: 'none',
  containerName: 'viewport',
  containerType: 'inline-size',
  background: cssVar('backgroundPrimaryColor'),
});
