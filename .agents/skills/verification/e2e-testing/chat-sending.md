# Verify website messaging

## Setup

See [shared setup](README.md#shared-setup). Use the
[authenticated provider workflow](../SKILL.md#authenticated-provider-checks)
for a real send.

## Test steps

1. Select a connected assistant in the sidebar.
   Expected: its website fills the middle pane.
2. On the website, enter a synthetic message and send it with the website's
   send control.
   Expected: the website displays the sent message.
3. Select a different connected assistant, then return to the first.
   Expected: the first website displays the same conversation.
4. Search for the synthetic message in the blibs search bar after sync.
   Expected: search finds the message under the correct provider.

## Automated coverage

The desktop smoke test `vendor sign-in entry point shows mocked steps and
returns home` checks clipboard shortcuts in the website. The test
`scripted Muse creates a project and writes a file from the composer`
exercises the provider composer and the relay with a local mock.
