for(const button of document.querySelectorAll('[data-variant]')){
  button.addEventListener('click',()=>{
    for(const tab of document.querySelectorAll('[data-variant]'))tab.setAttribute('aria-pressed',String(tab===button));
    for(const panel of document.querySelectorAll('[data-panel]'))panel.hidden=panel.dataset.panel!==button.dataset.variant;
  });
}
