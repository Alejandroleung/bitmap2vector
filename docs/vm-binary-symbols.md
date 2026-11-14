# Vector Magic vmde.exe 二进制里的符号残片（静态抓取）

来源：`D:\Vector Magic\vmde.exe`（PE/x86/32 位/Qt4/stripped），共 546 条形如函数签名的字符串。
RTTI 只保留了 48 个类型（Magick 异常类 + CancelTaskException），程序自己的类没有 RTTI，
但这些签名字符串足以还原**完整的设置面与流水线阶段**。

## 高级设置（算法参数面）（36）

- `aboutToStartTask(ThreadTaskType,VmVectorizationSettings*)`
- `addMruSettings(VectorizationSettings*)`
- `addOrOverwriteMruAdvSettings(QString,VectorizationSettings*)`
- `detectFlattenImageMode()`
- `prepareForTask(ThreadTaskType,VmVectorizationSettings*)`
- `setAdvAntiAliasingRejection(int)`
- `setAdvClusterColors(bool)`
- `setAdvColorSensitivity(int)`
- `setAdvContourSmoothness(int)`
- `setAdvCurveComplexity(int)`
- `setAdvDetectSharpCorners(bool)`
- `setAdvMinNumPixels(int)`
- `setAdvNumColors(int)`
- `setAdvSegmentationComplexity(int)`
- `setAdvUseContourAa(bool)`
- `setAdvUsePaletteAa(bool)`
- `setAdvancedModeSettings(AdvVectorizationSettings)`
- `setCustomFlattenImageColor(QColor)`
- `setFlattenImage(FlattenImageCommandType)`
- `setFlattenImage(FlattenImageCommandType,QColor)`
- `setFlattenImageColor(QColor)`
- `setFlattenImageColorToWhite()`
- `setFlattenImageCustomColor(QColor)`
- `setFlattenImageMode(FlattenImageModeType)`
- `setFlattenImageMode(int)`
- `setInputMode(InputModeType)`
- `setInputMode(InputModeType,bool)`
- `setInputMode(int)`
- `setInputMode(int,bool)`
- `setPaletteMode(VmPaletteModeType)`
- `setPreviewFlattenImageColorFromButton(int,bool)`
- `setRecommendedFlattenImageMode(FlattenImageModeType)`
- `setRecommendedPaletteMode(VmPaletteModeType)`
- `setTargetFlattenImageColor(QColor)`
- `setWizardMode(VmWizardModeType)`
- `updateCurrentFlattenImageColor()`

## 任务/线程（流水线阶段）（9）

- `aboutToStartTask(ThreadTaskType,VmVectorizationSettings*)`
- `cancelTask()`
- `cancelledTask(ThreadTaskType)`
- `cancellingTask()`
- `completedTask(ThreadTaskType,VmResultCode,bool,bool)`
- `doneWithTask(ThreadTaskType)`
- `failedTask(ThreadTaskType,VmResultCode)`
- `prepareForTask(ThreadTaskType,VmVectorizationSettings*)`
- `startedTask(ThreadTaskType)`

## 导出选项（5）

- `exporterSettingsChanged()`
- `setCakeStackMode(int)`
- `setDxfMode(int)`
- `setEpsCompatibilityMode(int)`
- `setShapeStrokingMode(int)`

## 调色板/分割编辑（37）

- `addPalette()`
- `addPalette(bool)`
- `addedEntryToPaletteList()`
- `advUpdatePalette()`
- `advUpdateSegmentation()`
- `clearPaletteList()`
- `clickPalette()`
- `hidePaletteImage()`
- `leavingPaletteWizardPage()`
- `palette color (RGB from colormap)`
- `paletteChanged()`
- `paletteCustomized()`
- `paletteCustomized(bool)`
- `paletteListChanged()`
- `paletteListSelectionMade(int)`
- `paletteSetFromList()`
- `paletteSetFromList(bool)`
- `revertPaletteEdits()`
- `revertSegmentation()`
- `revertSegmentationShallow()`
- `segmentationFetched(QColor)`
- `setAdvSegmentationComplexity(int)`
- `setAdvUsePaletteAa(bool)`
- `setBaseLayerToSegmentation()`
- `setCurrentLayerToSegmentation()`
- `setHoveredPalette(int)`
- `setPaletteColor(int,QColor)`
- `setPaletteFromList(int)`
- `setPaletteListColor(int,int,QColor,float)`
- `setPaletteMode(VmPaletteModeType)`
- `setPaletteMode(int)`
- `setRecommendedPaletteMode(VmPaletteModeType)`
- `setSegmentationVisible(bool)`
- `setSelectedPalette()`
- `setSelectedPalette(int)`
- `showPaletteImage()`
- `updateComparePaletteButtonState()`
