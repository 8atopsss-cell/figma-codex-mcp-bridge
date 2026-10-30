# Light license modal: explicit frame composition recipe

Status: prepared preview arguments; no live Figma write or visual acceptance performed by recipe author.

Source: live capture dated 2026-10-30, file SD Enterprice, page 4383:81972, selection/source 16079:56961, parent 16079:56949. Capture file: .cache/frame-composition-current-20261030.json. Source complete: 75 nodes, 29 INSTANCE nodes, 14 TEXT nodes; 12 explicitly hidden nodes retained. Capture inspected read-only; not rewritten.

Request file contains direct compose_source_frame arguments, dryRun:true. expectedState intentionally absent until actual preview. Revalidate active file, source and target state through preview before apply. Apply uses unchanged preview request, dryRun:false and exact returned expectedState. Source, library masters and existing 16112:22878 remain untouched.

## Placement reviewed against live parent

Coordinates x=1018,y=440 are final preview placement, parent-local in16079:56949. Existing appearance-only copy16112:22878 occupies x1018..1524,y0..365; new composition sits75px below it and ends y805 within parent height942. Dark source ends x941, leaving77px horizontal gap. The source parent's background rectangles remain behind the new window; no original Modal or highlight pin is covered. clipsContent=false; right edge1524 matches the existing copy's extent. Recheck the same parent geometry/membership during live preview/apply; these notes do not override drift guards.

## Composition and fallback

Root becomes a new ordinary FRAME; its Title/content SLOT containers become ordinary structural frames. Title text is read directly from source, including U+2028; no caller replacement string. Preserve child order, all geometry/layout, text, local visibility, opacity and hidden contents.

Both modal-card INSTANCE occurrences with main 14203:45837 explicitly appear in frameNodeIds. Scoped inventory: Server page 4383:81977 contained set plus three dark variants; light UI kit 4383:80553 contained no modal card. FRAME fallback approved for this new composition; no existing instance detached or edited.

Every atomic instance encountered outside an already mapped atomic subtree has an explicit mapping. Both nested radio instances explicitly map dark 1618:45519 to light 5025:42297; otherwise source-main preservation would restore dark radio. Source outer main 1834:54698 maps light outer 5025:42301.

| Source instance | Target main | Mapped properties | Explicit descendant pairs |
| --- | --- | ---: | ---: |
| I16079:56961;2043:48384 | 1900:44741 | 1 | 1 |
| I16079:56961;2043:48379;16079:56960 | 4553:39492 | 7 | 10 |
| I16079:56961;2043:48379;16079:57078;14203:45838;16079:57310 | 5025:42301 | 2 | 2 |
| I16079:56961;2043:48379;16079:57078;14203:45838;16079:57310;1834:54670 | 5025:42297 | 1 | 1 |
| I16079:56961;2043:48379;16079:57078;14203:45838;16079:57312 | 14637:56924 | 0 | 3 |
| I16079:56961;2043:48379;16079:57078;14203:45841 | 4391:92145 | 5 | 2 |
| I16079:56961;2043:48379;16079:57193;14203:45838;16079:57330 | 5025:42301 | 2 | 2 |
| I16079:56961;2043:48379;16079:57193;14203:45838;16079:57330;1834:54670 | 5025:42297 | 1 | 1 |
| I16079:56961;2043:48379;16079:57193;14203:45838;16079:57332 | 14637:56917 | 0 | 1 |
| I16079:56961;2043:48379;16079:57193;14203:45841 | 4391:92145 | 5 | 2 |
| I16079:56961;2043:48379;16096:57761 | 707:22164 | 0 | 1 |
| I16079:56961;2043:48387 | 4391:92073 | 5 | 2 |
| I16079:56961;2043:48392 | 4391:92145 | 5 | 2 |

Mappings contain 30 descendant pairs. Root excluded; pair traversal stops at nested INSTANCE. Pairs recorded from inspected topology and IDs, not inferred at execution from layer names. All paired types, child counts and componentPropertyReferences agree exactly. BOOLEAN/TEXT properties use actual identical schema keys, including leading/trailing spaces and # IDs. VARIANT properties explicitly map identical keys; selected target main and translated values must agree. Four button mappings include valueMap:{size:{"32px":"32"}}. Input state/size, radio Property 1 and shared-wrapper Property 1 retain exact source values. Target main geometry inspected.

Seven text differences versus target defaults are source overrides, preserved: input Label=Номер лицензии, input Text=10 цифр, hidden Description=Состоит из 10 цифр; two hidden button Labels=Расшифровать; cancel=отменить; save=сохранить. These differences do not authorize copying target default text.

Nested icons inside mapped instances retain source mains/content unless explicit nested mappings exist. In particular all three disabled-button icons retain download main 12416:35292, not target default add main 1893:44710. Preserve source wrapper, visibility, download vector and text. Shared close wrapper 1900:44741, desktop 14637:56924, server 14637:56917 and expand 707:22164 use same-main mappings, with light style overrides on source geometry. Hidden favorite icons retain main 2812:64107.

## Styles and verification

37 layerStyles entries cover every source nonempty fillStyleId/strokeStyleId (38 individual assignments). Source styles use verified light semantic counterparts. Disabled button descendants override dark secondary text to light_text_disabled for TEXT, light_icon_disable for icon geometry. Enabled secondary button inverse text maps light_text_primary, matching inspected light master. Modal-card background maps light_tab hover bcg, preserving semantic role. No guessed RGB, added shadow, or effectStyleId. Source typography/textStyleId preserved.

Static checks passed: complete75-node traversal,9full target trees,13maps,2fallbacks,30explicit layerpairs,all30propertyRefs exact,all BOOLEAN/TEXT property keys/types exact,all source styled layers covered,all referenced light styles present. No shape or child-count mismatch. Read-only text OpenType feature preservation still requires core verification/live readback because native API does not expose writable OpenType features.

Pending: parent placement review; core schema/native validation; build; actual dry-run; apply only within exact user approval; complete readback and user visual acceptance. New recipe does not imply live success.
