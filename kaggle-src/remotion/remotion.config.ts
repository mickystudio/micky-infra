/**
 * Remotion CLI configuration for Micky Assistant Montage Mode.
 *
 * Tuned for Kaggle T4 GPU environments (limited CPU cores, single GPU).
 * @see https://www.remotion.dev/docs/config
 */
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
// T4 GPU + 4 vCPUs on Kaggle: keep concurrency low to avoid OOM.
Config.setConcurrency(2);
// JPEG quality slightly below max → smaller frames, faster encode.
Config.setJpegQuality(90);
// Render in chunks so failures can resume.
Config.setChromiumOpenGlRenderer('angle');
