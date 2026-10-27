import { Composition, Folder } from "remotion";
import { fontsLoaded } from "./brand";
import { Demo, SCENE_COMPONENTS, Teaser } from "./Demo";
import { FPS, SCENES, TOTAL } from "./timeline";

// Fonts are loaded once for the whole bundle before any frame renders.
void fontsLoaded;

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="RevolveDemo" component={Demo} width={1920} height={1080} fps={FPS} durationInFrames={TOTAL} />
    <Composition id="RevolveTeaser" component={Teaser} width={1080} height={1080} fps={FPS} durationInFrames={300} />
    <Folder name="Scenes">
      {SCENES.map((sc) => (
        <Composition key={sc.id} id={`Scene-${sc.id}`} component={SCENE_COMPONENTS[sc.id]} width={1920} height={1080} fps={FPS} durationInFrames={sc.duration} />
      ))}
    </Folder>
  </>
);
