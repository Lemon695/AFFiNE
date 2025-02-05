import type {
  AIItemGroupConfig,
  DocMode,
  EdgelessCopilotWidget,
  EdgelessElementToolbarWidget,
  EdgelessRootBlockComponent,
} from '@blocksuite/affine/blocks';
import { EdgelessCopilotToolbarEntry } from '@blocksuite/affine/blocks';
import { noop } from '@blocksuite/affine/global/utils';
import { html } from 'lit';

import { getAIPanel } from '../../ai-panel';
import { AIProvider } from '../../provider';
import { getEdgelessCopilotWidget } from '../../utils/edgeless';
import { extractContext } from '../../utils/extract';
import { edgelessActionGroups } from './actions-config';

noop(EdgelessCopilotToolbarEntry);

export function setupEdgelessCopilot(widget: EdgelessCopilotWidget) {
  widget.groups = edgelessActionGroups;
}

export function setupEdgelessElementToolbarAIEntry(
  widget: EdgelessElementToolbarWidget
) {
  widget.registerEntry({
    when: () => {
      return true;
    },
    render: (edgeless: EdgelessRootBlockComponent) => {
      const chain = edgeless.service.std.command.chain();
      const filteredGroups = edgelessActionGroups.reduce((pre, group) => {
        const filtered = group.items.filter(item =>
          item.showWhen?.(chain, 'edgeless' as DocMode, edgeless.host)
        );

        if (filtered.length > 0) pre.push({ ...group, items: filtered });

        return pre;
      }, [] as AIItemGroupConfig[]);

      if (filteredGroups.every(group => group.items.length === 0)) return null;

      const handler = () => {
        const aiPanel = getAIPanel(edgeless.host);
        if (aiPanel.config) {
          aiPanel.config.generateAnswer = ({ finish, input }) => {
            finish('success');
            aiPanel.discard();
            AIProvider.slots.requestOpenWithChat.emit({ host: edgeless.host });
            extractContext(edgeless.host)
              .then(context => {
                AIProvider.slots.requestSendWithChat.emit({ input, context });
              })
              .catch(console.error);
          };
          aiPanel.config.inputCallback = text => {
            const copilotWidget = getEdgelessCopilotWidget(edgeless.host);
            const panel = copilotWidget.shadowRoot?.querySelector(
              'edgeless-copilot-panel'
            );
            if (panel instanceof HTMLElement) {
              panel.style.visibility = text ? 'hidden' : 'visible';
            }
          };
        }
      };

      return html`<edgeless-copilot-toolbar-entry
        .edgeless=${edgeless}
        .host=${edgeless.host}
        .groups=${edgelessActionGroups}
        .onClick=${handler}
      ></edgeless-copilot-toolbar-entry>`;
    },
  });
}
