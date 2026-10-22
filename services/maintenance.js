let active = false;
module.exports = {
    isActive: () => active,
    setActive: (value) => {
        active = !!value;
    }
};
