import React from "react";
import { Composition } from "remotion";
import { Paohui } from "./Paohui";

export const RemotionRoot: React.FC = () => {
  return (
    <>
{/* 炮灰视频（m3）：9:16 / 时长按 durationSec 动态计算（8~10 秒随机） */}
      <Composition
        id="Paohui"
        component={Paohui}
        durationInFrames={270}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ seed: "demo", durationSec: 9 }}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.round(((props as any).durationSec ?? 9) * 30),
        })}
      />
    </>
  );
};
